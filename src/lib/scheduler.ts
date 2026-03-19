/**
 * Task Scheduler — Simple cron-like scheduler for recurring tasks.
 * Uses setInterval and date checks (no external cron library).
 */

type ScheduleType = 'daily' | 'weekly';

interface ScheduledTask {
  name: string;
  schedule: ScheduleType;
  /** Time in "HH:MM" 24-hour format */
  time: string;
  /** Day of week for weekly tasks (0 = Sunday, 1 = Monday, ...) */
  dayOfWeek?: number;
  handler: () => Promise<void>;
  lastRun: string | null; // ISO date string of last execution
}

const registeredTasks: Map<string, ScheduledTask> = new Map();
let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Register a recurring task with the scheduler.
 *
 * @param name - Unique task name
 * @param schedule - 'daily' or 'weekly'
 * @param time - Execution time in "HH:MM" 24-hour format
 * @param handler - Async function to execute
 * @param dayOfWeek - Day of week for weekly tasks (0=Sun, 1=Mon, ..., 6=Sat). Defaults to 1 (Monday).
 */
export function registerTask(
  name: string,
  schedule: ScheduleType,
  time: string,
  handler: () => Promise<void>,
  dayOfWeek?: number
): void {
  registeredTasks.set(name, {
    name,
    schedule,
    time,
    dayOfWeek: schedule === 'weekly' ? (dayOfWeek ?? 1) : undefined,
    handler,
    lastRun: null
  });
  console.log(
    `[Scheduler] Registered task "${name}" — ${schedule} at ${time}${
      schedule === 'weekly' ? ` (day ${dayOfWeek ?? 1})` : ''
    }`
  );
}

/**
 * Check whether a task should run right now based on its schedule.
 */
function shouldRunTask(task: ScheduledTask, now: Date): boolean {
  const [targetHour, targetMinute] = task.time.split(':').map(Number);
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  // Time must match (within the same minute)
  if (currentHour !== targetHour || currentMinute !== targetMinute) {
    return false;
  }

  // For weekly tasks, check day of week
  if (task.schedule === 'weekly' && task.dayOfWeek !== undefined) {
    if (now.getDay() !== task.dayOfWeek) {
      return false;
    }
  }

  // Prevent double-run: check if already ran today at this time
  if (task.lastRun) {
    const lastRunDate = new Date(task.lastRun);
    if (
      lastRunDate.getFullYear() === now.getFullYear() &&
      lastRunDate.getMonth() === now.getMonth() &&
      lastRunDate.getDate() === now.getDate() &&
      lastRunDate.getHours() === currentHour &&
      lastRunDate.getMinutes() === currentMinute
    ) {
      return false;
    }
  }

  return true;
}

/**
 * The main tick function — runs every minute and checks all tasks.
 */
async function tick(): Promise<void> {
  const now = new Date();

  const tasks = Array.from(registeredTasks.values());
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (shouldRunTask(task, now)) {
      console.log(
        `[Scheduler] Running task "${task.name}" at ${now.toISOString()}`
      );
      task.lastRun = now.toISOString();
      try {
        await task.handler();
        console.log(`[Scheduler] Task "${task.name}" completed successfully`);
      } catch (error) {
        console.error(`[Scheduler] Task "${task.name}" failed:`, error);
      }
    }
  }
}

/**
 * Start the scheduler — checks every 60 seconds.
 */
export function startScheduler(): void {
  if (intervalId !== null) {
    console.warn('[Scheduler] Already running');
    return;
  }

  // Register built-in tasks
  registerBuiltInTasks();

  // Check every 60 seconds
  intervalId = setInterval(tick, 60_000);

  // Run an initial tick immediately
  tick();

  console.log('[Scheduler] Started');
}

/**
 * Stop the scheduler.
 */
export function stopScheduler(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Scheduler] Stopped');
  }
}

/**
 * Register the built-in daily summary and weekly report tasks.
 */
function registerBuiltInTasks(): void {
  // Daily Summary — every day at 8 PM (20:00)
  registerTask('daily-summary', 'daily', '20:00', async () => {
    // Dynamic import to avoid circular deps at module load time
    const { generateDailySummary } = await import('@/lib/notifications');
    await generateDailySummary();
  });

  // Weekly Report — every Monday at 9 AM (09:00)
  registerTask(
    'weekly-report',
    'weekly',
    '09:00',
    async () => {
      const { generateWeeklyReport } = await import('@/lib/notifications');
      await generateWeeklyReport();
    },
    1 // Monday
  );
}

/**
 * Get all registered tasks (for debugging / API).
 */
export function getRegisteredTasks(): Array<{
  name: string;
  schedule: ScheduleType;
  time: string;
  dayOfWeek?: number;
  lastRun: string | null;
}> {
  return Array.from(registeredTasks.values()).map((t) => ({
    name: t.name,
    schedule: t.schedule,
    time: t.time,
    dayOfWeek: t.dayOfWeek,
    lastRun: t.lastRun
  }));
}
