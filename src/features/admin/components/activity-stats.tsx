// Section C — 30-day activity stats (Phase 1).
// Phase 1 is intentionally text-only: shows the daily series as a
// simple sparkline-style table + funnel + rates. A real chart
// component goes in Phase 2 alongside the onboarding wizard.

interface SectionC {
  windowDays: number;
  messagesByDay: Array<{
    date: string;
    LEAD: number;
    AI: number;
    HUMAN: number;
  }>;
  stages: Record<string, number>;
  qualificationRate: number;
  bookingRate: number;
  showRate: number;
  avgQualityScore: number | null;
  totalLeads: number;
  qualifiedCount: number;
  bookedCount: number;
}

const FUNNEL_ORDER = [
  'NEW_LEAD',
  'ENGAGED',
  'QUALIFYING',
  'QUALIFIED',
  'CALL_PROPOSED',
  'BOOKED',
  'SHOWED',
  'CLOSED_WON'
];

function pct(v: number) {
  return `${(v * 100).toFixed(1)}%`;
}

export function ActivityStats({ sectionC }: { sectionC: SectionC }) {
  const totalsByDay = sectionC.messagesByDay.map(
    (d) => d.LEAD + d.AI + d.HUMAN
  );
  const peak = Math.max(1, ...totalsByDay);
  return (
    <section className='rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900'>
      <header className='mb-4'>
        <h3 className='text-sm font-semibold tracking-wide text-zinc-500 uppercase'>
          Activity (last {sectionC.windowDays} days)
        </h3>
      </header>

      <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
        <Stat
          label='Total leads'
          value={sectionC.totalLeads.toLocaleString()}
        />
        <Stat
          label='Qualification rate'
          value={pct(sectionC.qualificationRate)}
        />
        <Stat label='Booking rate' value={pct(sectionC.bookingRate)} />
        <Stat label='Show rate' value={pct(sectionC.showRate)} />
        <Stat
          label='Avg AI quality score'
          value={
            sectionC.avgQualityScore !== null
              ? sectionC.avgQualityScore.toFixed(2)
              : '—'
          }
        />
        <Stat
          label='Qualified leads'
          value={sectionC.qualifiedCount.toLocaleString()}
        />
        <Stat
          label='Booked / showed / won'
          value={sectionC.bookedCount.toLocaleString()}
        />
      </div>

      <div className='mt-6'>
        <p className='mb-2 text-xs tracking-wide text-zinc-500 uppercase'>
          Lead-stage funnel
        </p>
        <ul className='space-y-1 text-sm'>
          {FUNNEL_ORDER.map((stage) => {
            const count = sectionC.stages[stage] ?? 0;
            const pctOfTotal =
              sectionC.totalLeads > 0 ? count / sectionC.totalLeads : 0;
            return (
              <li
                key={stage}
                className='flex items-center justify-between gap-3'
              >
                <span className='w-44 text-xs tracking-wide text-zinc-500 uppercase'>
                  {stage}
                </span>
                <div className='h-2 flex-1 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800'>
                  <div
                    className='h-2 bg-blue-500'
                    style={{ width: `${pctOfTotal * 100}%` }}
                  />
                </div>
                <span className='w-12 text-right text-xs tabular-nums'>
                  {count}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className='mt-6'>
        <p className='mb-2 text-xs tracking-wide text-zinc-500 uppercase'>
          Daily message volume (LEAD · AI · HUMAN)
        </p>
        {sectionC.messagesByDay.length === 0 ? (
          <p className='text-xs text-zinc-500'>
            No messages in the last {sectionC.windowDays} days.
          </p>
        ) : (
          <div className='overflow-x-auto'>
            <table className='w-full text-xs tabular-nums'>
              <thead className='text-zinc-500'>
                <tr>
                  <th className='py-1 pr-3 text-left font-normal'>Date</th>
                  <th className='py-1 pr-3 text-right font-normal'>Lead</th>
                  <th className='py-1 pr-3 text-right font-normal'>AI</th>
                  <th className='py-1 pr-3 text-right font-normal'>Human</th>
                  <th className='py-1 pr-3 text-right font-normal'>Total</th>
                  <th className='py-1 text-left font-normal'>Bar</th>
                </tr>
              </thead>
              <tbody>
                {sectionC.messagesByDay.map((d, i) => {
                  const total = d.LEAD + d.AI + d.HUMAN;
                  return (
                    <tr
                      key={d.date}
                      className='border-t border-zinc-100 dark:border-zinc-800'
                    >
                      <td className='py-1 pr-3'>{d.date}</td>
                      <td className='py-1 pr-3 text-right'>{d.LEAD}</td>
                      <td className='py-1 pr-3 text-right'>{d.AI}</td>
                      <td className='py-1 pr-3 text-right'>{d.HUMAN}</td>
                      <td className='py-1 pr-3 text-right font-semibold'>
                        {total}
                      </td>
                      <td className='py-1'>
                        <div
                          className='inline-block h-2 rounded bg-blue-500'
                          style={{
                            width: `${Math.max(2, (totalsByDay[i] / peak) * 200)}px`
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className='rounded border border-zinc-100 p-3 dark:border-zinc-800'>
      <p className='text-xs tracking-wide text-zinc-500 uppercase'>{label}</p>
      <p className='mt-1 text-lg font-semibold tabular-nums'>{value}</p>
    </div>
  );
}
