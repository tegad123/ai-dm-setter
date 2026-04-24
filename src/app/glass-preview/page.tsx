/**
 * Unauthenticated preview of the Glass UI design system — lives outside
 * Clerk so the preview browser can see it. Exercises the main glass
 * primitives (backdrop, cards, KPI grid, alert card, pills, bubbles,
 * score bar, gradient button) with static data. Safe to remove once
 * the redesign lands, but doubles as a living style-guide.
 *
 * Route: /glass-preview
 */
import {
  Card,
  CardHeader,
  CardTitle,
  CardFooter,
  CardDescription
} from '@/components/ui/card';
import {
  IconUsers,
  IconCalendar,
  IconEye,
  IconTargetArrow,
  IconCash,
  IconMessage,
  IconTrendingUp,
  IconAlertTriangle
} from '@tabler/icons-react';

export default function GlassPreviewPage() {
  return (
    <>
      {/* app-bg renders from the root layout */}
      <main className='glass-fadeup relative z-10 mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10'>
        {/* Header */}
        <div className='flex items-center justify-between'>
          <div>
            <h1 className='num-big tracking-tight'>Glass UI Preview</h1>
            <p className='text-muted-foreground mt-1 text-sm'>
              Standalone style surface — no auth required
            </p>
          </div>
          <span className='tag tag-engaged'>
            <span className='tag-dot' /> Live
          </span>
        </div>

        {/* Alert card (Action Required style) */}
        <div className='alert-card'>
          <div className='alert-icon'>
            <IconAlertTriangle className='h-5 w-5' />
          </div>
          <div className='flex-1'>
            <div className='text-sm font-semibold'>Action Required</div>
            <div className='text-muted-foreground text-xs'>
              2 distress signals, 1 stuck conversation. Tap to review.
            </div>
          </div>
          <button className='btn-primary-glass rounded-xl px-4 py-2 text-xs font-semibold'>
            Review
          </button>
        </div>

        {/* KPI grid */}
        <div className='grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6'>
          {[
            {
              icon: IconUsers,
              label: 'Total Leads',
              num: '1,248',
              delta: '+18%'
            },
            { icon: IconMessage, label: 'Leads Today', num: '47', delta: '+3' },
            {
              icon: IconCalendar,
              label: 'Calls Booked',
              num: '89',
              delta: 'This month'
            },
            { icon: IconEye, label: 'Show Rate', num: '72%', delta: '+5%' },
            {
              icon: IconTargetArrow,
              label: 'Close Rate',
              num: '31%',
              delta: '+8%'
            },
            { icon: IconCash, label: 'Revenue', num: '$42,100', delta: '+24%' }
          ].map(({ icon: Icon, label, num, delta }) => (
            <Card
              key={label}
              className='glass glass-sm @container/card border-0 py-4'
            >
              <CardHeader className='pb-2'>
                <div className='kpi-head'>
                  <div className='kpi-icon'>
                    <Icon className='h-4 w-4' />
                  </div>
                  <CardDescription className='font-medium'>
                    {label}
                  </CardDescription>
                </div>
                <CardTitle className='num-big'>{num}</CardTitle>
              </CardHeader>
              <CardFooter className='text-xs'>
                <span className='kpi-delta up flex items-center gap-1'>
                  <IconTrendingUp className='h-3 w-3' /> {delta}
                </span>
              </CardFooter>
            </Card>
          ))}
        </div>

        {/* Tag pill showcase */}
        <section className='glass glass-sm p-6'>
          <h2 className='mb-4 text-sm font-semibold'>Status pills</h2>
          <div className='flex flex-wrap gap-2'>
            <span className='tag tag-hot'>
              <span className='tag-dot' /> Hot lead
            </span>
            <span className='tag tag-qualified'>Qualified</span>
            <span className='tag tag-call'>Call proposed</span>
            <span className='tag tag-booked'>Booked</span>
            <span className='tag tag-new'>New</span>
            <span className='tag tag-engaged'>Engaged</span>
            <span className='tag tag-qualifying'>Qualifying</span>
            <span className='tag tag-showed'>Showed</span>
            <span className='tag tag-noshow'>No-show</span>
            <span className='tag tag-closedwon'>Closed won</span>
          </div>
        </section>

        {/* Conversation bubbles */}
        <section className='glass glass-sm p-6'>
          <h2 className='mb-4 text-sm font-semibold'>Conversation bubbles</h2>
          <div className='flex flex-col gap-3'>
            <div className='flex justify-start'>
              <div className='glass-bubble theirs'>
                yo saw your post about trading. whats the vibe?
              </div>
            </div>
            <div className='flex justify-end'>
              <div className='glass-bubble mine'>
                yoo what&apos;s good bro! glad it caught your eye 💪🏿 are you new
                in the markets or been trading a while?
              </div>
            </div>
            <div className='flex justify-start'>
              <div className='glass-bubble theirs'>
                been at it about a year, still grinding tho
              </div>
            </div>
            <div className='flex justify-end'>
              <div className='glass-bubble mine-human'>
                hey this is anthony, jumping in from here. we should hop on a
                quick call
              </div>
            </div>
          </div>
        </section>

        {/* Score bar */}
        <section className='glass glass-sm p-6'>
          <h2 className='mb-3 text-sm font-semibold'>Score bar</h2>
          <div className='flex flex-col gap-3'>
            <div>
              <div className='text-muted-foreground mb-1 text-xs'>
                Lead quality (cool)
              </div>
              <div className='score-bar cool'>
                <div style={{ width: '68%' }} />
              </div>
            </div>
            <div>
              <div className='text-muted-foreground mb-1 text-xs'>
                Booking readiness (default)
              </div>
              <div className='score-bar'>
                <div style={{ width: '84%' }} />
              </div>
            </div>
            <div>
              <div className='text-muted-foreground mb-1 text-xs'>
                Friction (warm)
              </div>
              <div className='score-bar warm'>
                <div style={{ width: '32%' }} />
              </div>
            </div>
          </div>
        </section>

        {/* Conversation list rows */}
        <section className='glass glass-sm p-6'>
          <h2 className='mb-3 text-sm font-semibold'>Conversation list</h2>
          <div className='flex flex-col gap-1'>
            {[
              {
                name: 'Jonathan Frimpong',
                handle: 'jfrimpong',
                initials: 'JF',
                preview: "here's the link bro: https://form.typeform.com/to/…",
                time: '2h',
                active: true
              },
              {
                name: 'Sean Ramirez',
                handle: 'seanrmz',
                initials: 'SR',
                preview: 'been looking at it for a month honestly',
                time: '4h',
                active: false
              },
              {
                name: 'Carlos Mendez',
                handle: 'carlosmx',
                initials: 'CM',
                preview: 'yeah im interested whats the next step',
                time: '1d',
                active: false
              }
            ].map((c) => (
              <button
                key={c.name}
                className={
                  c.active
                    ? 'conv-item active w-full text-left'
                    : 'conv-item w-full text-left'
                }
                type='button'
              >
                <div className='conv-avatar'>{c.initials}</div>
                <div className='flex-1 overflow-hidden'>
                  <div className='flex items-center justify-between'>
                    <span className='conv-name'>{c.name}</span>
                    <span className='conv-time'>{c.time}</span>
                  </div>
                  <div className='conv-preview'>
                    @{c.handle} · {c.preview}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Inputs + buttons */}
        <section className='glass glass-sm flex flex-col gap-4 p-6'>
          <h2 className='text-sm font-semibold'>Inputs + buttons</h2>
          <input
            type='text'
            placeholder='Search leads, tags, scripts…'
            className='glass-input'
          />
          <div className='flex flex-wrap gap-2'>
            <button className='btn btn-primary'>Book call</button>
            <button className='btn btn-ghost'>Dismiss</button>
          </div>
          <div className='segmented'>
            <button className='active'>All</button>
            <button>Priority</button>
            <button>Qualified</button>
            <button>Unread</button>
          </div>
          <div className='flex items-center gap-3'>
            <button
              type='button'
              className='glass-toggle on'
              aria-label='Enabled'
            />
            <span className='text-muted-foreground text-sm'>AI auto-send</span>
          </div>
          <div className='glass-progress'>
            <div style={{ width: '58%' }} />
          </div>
        </section>
      </main>
    </>
  );
}
