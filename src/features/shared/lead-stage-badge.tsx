import { Badge } from '@/components/ui/badge';

export type LeadStage =
  | 'new_lead'
  | 'engaged'
  | 'qualifying'
  | 'qualified'
  | 'call_proposed'
  | 'booked'
  | 'showed'
  | 'no_showed'
  | 'rescheduled'
  | 'closed_won'
  | 'closed_lost'
  | 'unqualified'
  | 'ghosted'
  | 'nurture';

const stageConfig: Record<LeadStage, { label: string; className: string }> = {
  new_lead: {
    label: 'New Lead',
    className:
      'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800'
  },
  engaged: {
    label: 'Engaged',
    className:
      'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400 border-cyan-200 dark:border-cyan-800'
  },
  qualifying: {
    label: 'Qualifying',
    className:
      'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800'
  },
  qualified: {
    label: 'Qualified',
    className:
      'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800'
  },
  call_proposed: {
    label: 'Call Proposed',
    className:
      'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800'
  },
  booked: {
    label: 'Booked',
    className:
      'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800'
  },
  showed: {
    label: 'Showed',
    className:
      'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800'
  },
  no_showed: {
    label: 'No Showed',
    className:
      'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800'
  },
  rescheduled: {
    label: 'Rescheduled',
    className:
      'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800'
  },
  closed_won: {
    label: 'Closed Won',
    className:
      'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 border-purple-200 dark:border-purple-800'
  },
  closed_lost: {
    label: 'Closed Lost',
    className:
      'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400 border-rose-200 dark:border-rose-800'
  },
  unqualified: {
    // Red styling signals "do not pursue" without being alarming.
    // Slightly heavier font weight + stronger text contrast than the
    // neutral stages so the badge visually reads as terminal.
    label: 'Unqualified',
    className:
      'bg-red-100 text-red-800 font-semibold dark:bg-red-900/40 dark:text-red-200 border-red-300 dark:border-red-800'
  },
  ghosted: {
    label: 'Ghosted',
    className:
      'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400 border-gray-200 dark:border-gray-800'
  },
  nurture: {
    label: 'Nurture',
    className:
      'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400 border-teal-200 dark:border-teal-800'
  }
};

export const allStages = Object.entries(stageConfig).map(([value, config]) => ({
  value: value as LeadStage,
  label: config.label
}));

export function LeadStageBadge({ stage }: { stage: LeadStage }) {
  const config = stageConfig[stage];
  if (!config) return <Badge variant='outline'>{stage}</Badge>;

  return (
    <Badge variant='outline' className={config.className}>
      {config.label}
    </Badge>
  );
}
