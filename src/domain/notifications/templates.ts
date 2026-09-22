/**
 * What a notification says.
 *
 * The hard part of an inbox is not delivering things, it is deciding what is
 * worth delivering. The rule here: **a notification is an event, not a state.**
 *
 * "You have eleven critical tasks" is a state. It is true every day, the task
 * list already says it, and repeating it in an inbox trains people to ignore
 * the inbox. "This was escalated to you because nobody acted on it for three
 * days" is an event: it became true at a moment, it is somebody's fault or
 * nobody's, and it will not be said again.
 *
 * That distinction is why switching this on against the existing eighty-eight
 * tasks produces seven notifications rather than forty. The seven are the ones
 * that actually happened.
 *
 * Pure — no database, no clock. CLAUDE.md §5.
 */

export type TemplateCode = 'TASK_ESCALATED' | 'BILL_STAGE_CHANGED'

export interface Composed {
  subject: string
  /** One or two plain sentences. The row links to the thing itself. */
  body: string
}

/** Everything a template may read. Unknown keys are ignored, never rendered. */
export interface Payload {
  taskTitle?: string
  ruleCode?: string | null
  dueDate?: string | null
  daysOverdue?: number | null
  firmName?: string | null
  projectCode?: string | null
  billNo?: number | null
  fromStage?: string | null
  toStage?: string | null
  actorName?: string | null
  amount?: string | null
}

const stage = (s: string | null | undefined) =>
  (s ?? '').replace(/_/g, ' ').trim() || 'a new stage'

export function compose(code: TemplateCode, p: Payload): Composed {
  switch (code) {
    case 'TASK_ESCALATED':
      return {
        subject: `Escalated to you: ${p.taskTitle ?? 'a task'}`,
        body: [
          p.daysOverdue != null && p.daysOverdue > 0
            ? `${p.daysOverdue} days overdue and nobody has acted on it.`
            : 'Nobody has acted on it since it was raised.',
          [p.firmName, p.projectCode].filter(Boolean).join(' · '),
        ].filter(Boolean).join(' ').trim(),
      }

    case 'BILL_STAGE_CHANGED':
      return {
        subject: `Bill #${p.billNo ?? '—'} moved to ${stage(p.toStage)}`,
        body: [
          p.fromStage ? `From ${stage(p.fromStage)}.` : null,
          p.actorName ? `Moved by ${p.actorName}.` : null,
          [p.projectCode, p.amount].filter(Boolean).join(' · '),
        ].filter(Boolean).join(' ').trim(),
      }
  }
}

/**
 * How long a notification stays interesting.
 *
 * Not a delete — the row is history. This is what the inbox stops showing, so
 * that coming back after a fortnight away does not mean reading a fortnight of
 * things that have since been dealt with.
 */
export const INBOX_DAYS = 30
