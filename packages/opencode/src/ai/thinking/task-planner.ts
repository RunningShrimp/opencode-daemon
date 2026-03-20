import { z } from "zod"
import { createPlan, createPlanningStep, createPlanningTask, type Plan, validatePlan } from "./planning"
import type { TaskIntent } from "./intent"

export const PlannerConstraint = z.object({
  kind: z.enum(["requirement", "prohibition", "environment", "quality"]),
  value: z.string(),
})

export const PlannerTaskNode = z.object({
  id: z.string(),
  description: z.string(),
  phase: z.enum(["clarify", "inspect", "retrieve", "implement", "verify", "finalize"]),
  priority: z.enum(["low", "medium", "high", "critical"]),
  dependencies: z.array(z.string()),
  evidence: z.array(z.string()),
  doneWhen: z.array(z.string()),
})

export const StructuredTaskPlan = z.object({
  intentType: z.string(),
  goal: z.string(),
  constraints: z.array(PlannerConstraint),
  successCriteria: z.array(z.string()),
  evidenceNeeds: z.array(z.string()),
  clarificationQuestions: z.array(z.string()),
  fallbackPlan: z.array(z.string()),
  taskGraph: z.array(PlannerTaskNode),
  plan: z.custom<Plan>(),
})

export type StructuredTaskPlan = z.infer<typeof StructuredTaskPlan>

function splitWork(prompt: string) {
  return prompt
    .split(/(?:\n+|；|;|，|,|然后|并且|接着|再|最后|and then|then|after that|finally)/g)
    .map((part) => part.trim())
    .filter(Boolean)
}

function fallbackGoalForIntent(intent: TaskIntent) {
  switch (intent.type) {
    case "review":
      return intent.target.trim() || `Perform a ${intent.scope} review`
    case "debugging":
      return intent.error.trim() || "Investigate the reported failure"
    case "exploration":
      return intent.query.trim() || "Answer the current request"
    case "implementation":
      return intent.description.trim() || "Implement the requested change"
    default:
      return "Resolve the current turn"
  }
}

function normalizePlannerGoal(prompt: string, intent: TaskIntent) {
  const trimmed = prompt.trim()
  return trimmed || fallbackGoalForIntent(intent)
}

function extractConstraints(prompt: string) {
  const constraints: StructuredTaskPlan["constraints"] = []
  const lines = prompt.split(/\n+/).map((line) => line.trim())
  for (const line of lines) {
    const lower = line.toLowerCase()
    if (/(不要|不能|禁止|do not|don't|without)/i.test(line)) {
      constraints.push({ kind: "prohibition", value: line })
      continue
    }
    if (/(必须|需要|should|must|required)/i.test(line)) {
      constraints.push({ kind: "requirement", value: line })
      continue
    }
    if (/(测试|test|验证|typecheck|lint|安全|performance|quality)/i.test(line)) {
      constraints.push({ kind: "quality", value: line })
    }
  }
  return constraints
}

function inferPlanTasks(prompt: string, intent: TaskIntent, constraints: StructuredTaskPlan["constraints"]) {
  const tasks: z.infer<typeof PlannerTaskNode>[] = []
  const promptParts = splitWork(prompt)
  const workItems = promptParts.length > 0 ? promptParts : [prompt.trim()]

  const addTask = (
    description: string,
    phase: z.infer<typeof PlannerTaskNode>["phase"],
    priority: z.infer<typeof PlannerTaskNode>["priority"],
    dependencies: string[],
    evidence: string[],
    doneWhen: string[],
  ) => {
    const task = PlannerTaskNode.parse({
      id: crypto.randomUUID(),
      description,
      phase,
      priority,
      dependencies,
      evidence,
      doneWhen,
    })
    tasks.push(task)
    return task
  }

  const inspect = addTask(
    inspectTaskForIntent(intent),
    "inspect",
    "high",
    [],
    defaultEvidence(intent),
    ["Relevant files, docs, or failing paths are identified"],
  )

  const explicitTasks = workItems
    .filter((item) => item && item.toLowerCase() !== prompt.trim().toLowerCase())
    .map((item, index) => {
      const phase = inferPhase(item, intent)
      const deps = index === 0 ? [inspect.id] : [tasks[tasks.length - 1].id]
      return addTask(
        item,
        phase,
        phase === "implement" ? "high" : "medium",
        deps,
        defaultEvidence(intent),
        doneWhenForTask(item, phase),
      )
    })

  if (explicitTasks.length === 0) {
    addTask(
      primaryExecutionTask(intent, prompt),
      intent.type === "exploration" ? "retrieve" : "implement",
      "high",
      [inspect.id],
      defaultEvidence(intent),
      doneWhenForTask(prompt, intent.type === "exploration" ? "retrieve" : "implement"),
    )
  }

  const verifyDependencies = tasks.filter((task) => task.phase !== "verify" && task.phase !== "finalize").map((task) => task.id)
  addTask(
    verificationTaskForIntent(intent, constraints),
    "verify",
    "high",
    verifyDependencies,
    defaultEvidence(intent),
    defaultCriteria(intent),
  )

  return tasks
}

function inferPhase(item: string, intent: TaskIntent): z.infer<typeof PlannerTaskNode>["phase"] {
  const lower = item.toLowerCase()
  if (/(clarify|确认|澄清|question)/i.test(item)) return "clarify"
  if (/(search|find|locate|inspect|read|analyze|检查|定位|阅读)/i.test(item)) return "inspect"
  if (/(doc|document|answer|summarize|总结|文档)/i.test(item) && intent.type === "exploration") return "retrieve"
  if (/(verify|test|lint|typecheck|validate|回归|验证|测试)/i.test(item)) return "verify"
  if (/(final|finalize|wrap|收尾|整理)/i.test(item)) return "finalize"
  return intent.type === "exploration" ? "retrieve" : "implement"
}

function inspectTaskForIntent(intent: TaskIntent) {
  switch (intent.type) {
    case "review":
      return `Inspect the ${intent.scope} review surface and gather candidate evidence`
    case "debugging":
      return `Inspect the failing path and reproduce or isolate the error: ${intent.error.trim() || "reported failure"}`
    case "exploration":
      return `Inspect the relevant code or docs needed to answer: ${intent.query.trim() || "current request"}`
    case "implementation":
      return `Inspect the existing implementation surface for: ${intent.description.trim() || "requested change"}`
    default:
      return "Inspect the relevant implementation surface"
  }
}

function primaryExecutionTask(intent: TaskIntent, prompt: string) {
  switch (intent.type) {
    case "review":
      return `Review the target and enumerate evidence-backed findings: ${intent.target.trim() || "requested target"}`
    case "debugging":
      return `Fix the root cause for: ${intent.error.trim() || "reported failure"}`
    case "exploration":
      return `Answer the exploration request directly: ${intent.query.trim() || "current request"}`
    case "implementation":
      return `Implement the requested change: ${intent.description || prompt}`
    default:
      return prompt.trim() ? `Resolve the requested task: ${prompt}` : "Resolve the current turn"
  }
}

function verificationTaskForIntent(intent: TaskIntent, constraints: StructuredTaskPlan["constraints"]) {
  const quality = constraints.filter((item) => item.kind === "quality" || item.kind === "requirement").map((item) => item.value)
  switch (intent.type) {
    case "review":
      return `Verify each review finding is backed by concrete code or test evidence${quality.length > 0 ? ` and respect: ${quality[0]}` : ""}`
    case "debugging":
      return `Verify the failure no longer reproduces and that no regression was introduced${quality.length > 0 ? `; include ${quality[0]}` : ""}`
    case "exploration":
      return `Verify the answer is supported by the retrieved evidence${quality.length > 0 ? ` and ${quality[0]}` : ""}`
    default:
      return `Verify the implementation against constraints and success criteria${quality.length > 0 ? `, including ${quality[0]}` : ""}`
  }
}

function doneWhenForTask(description: string, phase: z.infer<typeof PlannerTaskNode>["phase"]) {
  switch (phase) {
    case "clarify":
      return ["Ambiguity is explicitly called out or resolved"]
    case "inspect":
      return ["Relevant files, docs, or evidence sources are identified"]
    case "retrieve":
      return ["The requested answer has source-backed support"]
    case "verify":
      return ["Verification evidence is available"]
    case "finalize":
      return ["The result is packaged for delivery"]
    default:
      return [`The work item is completed: ${description}`]
  }
}

function deriveClarificationQuestions(prompt: string, intent: TaskIntent, constraints: StructuredTaskPlan["constraints"]) {
  const questions: string[] = []
  const lower = prompt.toLowerCase()
  if (prompt.trim().split(/\s+/).length <= 3) {
    questions.push("Which file, module, or surface is in scope?")
  }
  if (intent.type === "implementation" && !/[./][a-z0-9_-]+|src\/|packages\/|README|docs\//i.test(prompt)) {
    questions.push("Which code area or artifact should be changed?")
  }
  if (intent.type === "review" && intent.target.trim().length < 8) {
    questions.push("What exact code path or artifact should be reviewed?")
  }
  if (intent.type === "debugging" && !/(stack|trace|error|exception|failed|crash)/i.test(lower)) {
    questions.push("What concrete failure message or reproduction signal is available?")
  }
  if (!constraints.some((item) => item.kind === "quality") && intent.type !== "exploration") {
    questions.push("Which verification signal matters most: tests, typecheck, lint, or runtime behavior?")
  }
  return [...new Set(questions)].slice(0, 4)
}

function deriveFallbackPlan(intent: TaskIntent) {
  switch (intent.type) {
    case "review":
      return [
        "If evidence is insufficient, lower confidence and label the finding as a risk instead of a defect.",
        "If the scope is ambiguous, narrow the review target before continuing.",
      ]
    case "debugging":
      return [
        "If reproduction fails, capture the most concrete failing evidence available and inspect the nearest code path.",
        "If the first fix does not hold under verification, revert to the last known-good hypothesis and try the next likely root cause.",
      ]
    case "exploration":
      return [
        "If direct evidence is sparse, answer narrowly and state the uncertainty explicitly.",
      ]
    default:
      return [
        "If implementation verification fails, revert to the last verified state and reduce the change scope.",
        "If constraints conflict, preserve correctness and existing behavior before optional improvements.",
      ]
  }
}

function buildPlanFromTaskGraph(sessionID: string, goal: string, taskGraph: z.infer<typeof PlannerTaskNode>[]) {
  const phaseLabels: Array<{ phase: z.infer<typeof PlannerTaskNode>["phase"]; description: string; outcome: string }> = [
    { phase: "clarify", description: "Clarify scope", outcome: "Ambiguities are called out or resolved" },
    { phase: "inspect", description: "Inspect evidence surface", outcome: "Relevant files and evidence sources are identified" },
    { phase: "retrieve", description: "Retrieve supporting context", outcome: "Relevant source-backed context is available" },
    { phase: "implement", description: "Execute the change", outcome: "Primary work items are completed" },
    { phase: "verify", description: "Verify outcome", outcome: "Success criteria are checked against evidence" },
    { phase: "finalize", description: "Finalize delivery", outcome: "Result is ready to present" },
  ]

  const steps = phaseLabels
    .map((item, index) => {
      const tasks = taskGraph.filter((task) => task.phase === item.phase)
      if (tasks.length === 0) return undefined
      return createPlanningStep(
        index + 1,
        item.description,
        item.outcome,
        tasks.map((task) => ({
          ...createPlanningTask(task.description, task.priority, task.dependencies),
          id: task.id,
          evidence: task.evidence,
        })),
      )
    })
    .filter((s): s is NonNullable<typeof s> => s !== undefined)

  const plan = createPlan(sessionID, goal, steps)
  const validation = validatePlan(plan)
  if (!validation.valid) {
    throw new Error(`Planner generated an invalid task graph: ${validation.errors.join("; ")}`)
  }
  return plan
}

function defaultCriteria(intent: TaskIntent) {
  switch (intent.type) {
    case "review":
      return ["Enumerate concrete findings", "Back each finding with evidence", "Call out residual risks"]
    case "debugging":
      return ["Identify root cause", "Apply a fix", "Validate that the failure no longer reproduces"]
    case "exploration":
      return ["Answer the question directly", "Attach relevant code or document evidence"]
    default:
      return ["Implement the requested behavior", "Preserve existing behavior unless intentionally changed", "Validate the result"]
  }
}

function defaultEvidence(intent: TaskIntent) {
  switch (intent.type) {
    case "review":
      return ["Changed code paths", "Relevant tests", "Risk and edge-case evidence"]
    case "debugging":
      return ["Failing path evidence", "Fix-path evidence", "Regression proof"]
    case "exploration":
      return ["Primary source files", "Relevant docs or configs"]
    default:
      return ["Existing implementation references", "Verification output"]
  }
}

export function buildStructuredTaskPlan(input: { sessionID: string; prompt: string; intent: TaskIntent }): StructuredTaskPlan {
  const goal = normalizePlannerGoal(input.prompt, input.intent)
  const constraints = extractConstraints(input.prompt)
  const taskGraph = inferPlanTasks(goal, input.intent, constraints)
  const plan = buildPlanFromTaskGraph(input.sessionID, goal, taskGraph)

  return StructuredTaskPlan.parse({
    intentType: input.intent.type,
    goal,
    constraints,
    successCriteria: defaultCriteria(input.intent),
    evidenceNeeds: defaultEvidence(input.intent),
    clarificationQuestions: deriveClarificationQuestions(input.prompt, input.intent, constraints),
    fallbackPlan: deriveFallbackPlan(input.intent),
    taskGraph,
    plan,
  })
}

export function renderStructuredTaskPlan(plan: StructuredTaskPlan) {
  const lines = [
    "<task_plan>",
    `Intent: ${plan.intentType}`,
    `Goal: ${plan.goal}`,
  ]
  if (plan.constraints.length > 0) {
    lines.push("Constraints:")
    for (const constraint of plan.constraints.slice(0, 6)) {
      lines.push(`- ${constraint.kind}: ${constraint.value}`)
    }
  }
  if (plan.clarificationQuestions.length > 0) {
    lines.push("Clarify if needed:")
    for (const item of plan.clarificationQuestions) lines.push(`- ${item}`)
  }
  lines.push("Success criteria:")
  for (const criterion of plan.successCriteria) lines.push(`- ${criterion}`)
  lines.push("Evidence needed:")
  for (const item of plan.evidenceNeeds) lines.push(`- ${item}`)
  lines.push("Task graph:")
  for (const task of plan.taskGraph.slice(0, 10)) {
    const deps = task.dependencies.length > 0 ? ` after ${task.dependencies.join(", ")}` : ""
    lines.push(`- [${task.phase}] ${task.description}${deps}`)
  }
  if (plan.fallbackPlan.length > 0) {
    lines.push("Fallback plan:")
    for (const item of plan.fallbackPlan.slice(0, 4)) lines.push(`- ${item}`)
  }
  lines.push("</task_plan>")
  return lines.join("\n")
}