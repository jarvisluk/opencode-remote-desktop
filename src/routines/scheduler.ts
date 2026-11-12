import { randomUUID } from "node:crypto"
import type { Context } from "@opencode/plugin/promise/plugin"

export interface RoutineRecord {
  readonly id: string
  readonly name: string
  readonly prompt: string
  readonly everyMinutes?: number
  readonly dailyAt?: string
  readonly enabled: boolean
  readonly sessionID?: string
  readonly lastRunAt?: number
  readonly nextRunAt: number
  readonly createdAt: number
}

const ROUTINE_PREFIX = "routines/"

export function computeNextRunAt(
  spec: { readonly everyMinutes?: number; readonly dailyAt?: string },
  now = Date.now(),
): number {
  if (typeof spec.everyMinutes === "number" && spec.everyMinutes > 0) {
    return now + Math.round(spec.everyMinutes * 60_000)
  }
  if (typeof spec.dailyAt === "string") {
    const m = spec.dailyAt.trim().match(/^(\d{1,2}):(\d{2})$/)
    if (m) {
      const hour = Number(m[1])
      const minute = Number(m[2])
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        const candidate = new Date(now)
        candidate.setHours(hour, minute, 0, 0)
        if (candidate.getTime() <= now) {
          candidate.setDate(candidate.getDate() + 1)
        }
        return candidate.getTime()
      }
    }
  }
  return now + 60 * 60_000
}

export class RoutineScheduler {
  private readonly ctx: Context
  private readonly acquireAwake: () => () => void
  private readonly pollMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(ctx: Context, acquireAwake: () => () => void, pollMs: number) {
    this.ctx = ctx
    this.acquireAwake = acquireAwake
    this.pollMs = pollMs
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.pollMs)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async list(): Promise<RoutineRecord[]> {
    const scan = await this.ctx.storage.scan({ prefix: ROUTINE_PREFIX, limit: 200 })
    const list: RoutineRecord[] = []
    for (const entry of scan.entries) {
      const val = entry.value as unknown as RoutineRecord | undefined
      if (val && typeof val.id === "string" && typeof val.prompt === "string") {
        list.push(val)
      }
    }
    return list.sort((a, b) => a.createdAt - b.createdAt)
  }

  async create(input: {
    readonly name: string
    readonly prompt: string
    readonly everyMinutes?: number
    readonly dailyAt?: string
    readonly reuseSession?: boolean
  }): Promise<RoutineRecord> {
    const id = `rt_${randomUUID().slice(0, 8)}`
    const now = Date.now()
    let sessionID: string | undefined
    if (input.reuseSession !== false) {
      const created = await this.ctx.session.create({ title: `[DotBot Routine] ${input.name}` })
      sessionID = created.id
    }
    const record: RoutineRecord = {
      id,
      name: input.name,
      prompt: input.prompt,
      everyMinutes: input.everyMinutes,
      dailyAt: input.dailyAt,
      enabled: true,
      sessionID,
      nextRunAt: computeNextRunAt(input, now),
      createdAt: now,
    }
    await this.ctx.storage.set(`${ROUTINE_PREFIX}${id}`, record as unknown as Record<string, any>)
    return record
  }

  async setEnabled(id: string, enabled: boolean): Promise<RoutineRecord | null> {
    const existing = (await this.ctx.storage.get(`${ROUTINE_PREFIX}${id}`)) as unknown as RoutineRecord | undefined
    if (!existing) return null
    const updated: RoutineRecord = {
      ...existing,
      enabled,
      nextRunAt: enabled ? computeNextRunAt(existing, Date.now()) : existing.nextRunAt,
    }
    await this.ctx.storage.set(`${ROUTINE_PREFIX}${id}`, updated as unknown as Record<string, any>)
    return updated
  }

  async remove(id: string): Promise<boolean> {
    const existing = await this.ctx.storage.get(`${ROUTINE_PREFIX}${id}`)
    if (!existing) return false
    await this.ctx.storage.remove(`${ROUTINE_PREFIX}${id}`)
    return true
  }

  async triggerNow(id: string): Promise<{ readonly ok: boolean; readonly sessionID?: string; readonly error?: string }> {
    const existing = (await this.ctx.storage.get(`${ROUTINE_PREFIX}${id}`)) as unknown as RoutineRecord | undefined
    if (!existing) return { ok: false, error: `Routine not found: ${id}` }
    return this.executeRoutine(existing)
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = Date.now()
      const routines = await this.list()
      for (const routine of routines) {
        if (!routine.enabled || routine.nextRunAt > now) continue
        await this.executeRoutine(routine)
      }
    } catch {
      // Never crash background loop on transient storage/session errors.
    } finally {
      this.ticking = false
    }
  }

  private async executeRoutine(
    routine: RoutineRecord,
  ): Promise<{ readonly ok: boolean; readonly sessionID?: string; readonly error?: string }> {
    const releaseAwake = this.acquireAwake()
    try {
      const now = Date.now()
      let targetSessionID = routine.sessionID
      if (!targetSessionID) {
        const created = await this.ctx.session.create({
          title: `[DotBot] ${routine.name} (${new Date(now).toLocaleString()})`,
        })
        targetSessionID = created.id
      }

      const updated: RoutineRecord = {
        ...routine,
        sessionID: routine.sessionID ?? targetSessionID,
        lastRunAt: now,
        nextRunAt: computeNextRunAt(routine, now),
      }
      await this.ctx.storage.set(`${ROUTINE_PREFIX}${routine.id}`, updated as unknown as Record<string, any>)

      await this.ctx.session.prompt({
        sessionID: targetSessionID as any,
        text: `[DotBot Scheduled Routine: ${routine.name}]\n\n${routine.prompt}`,
        delivery: "queue",
      })
      return { ok: true, sessionID: targetSessionID }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      releaseAwake()
    }
  }
}
