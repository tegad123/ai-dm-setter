import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';

const recentActivity = [
  {
    name: 'Marcus Johnson',
    action: 'Call booked',
    time: '5m ago',
    initials: 'MJ',
    platform: 'IG'
  },
  {
    name: 'Sarah Mitchell',
    action: 'Hot lead detected',
    time: '18m ago',
    initials: 'SM',
    platform: 'IG'
  },
  {
    name: 'David Kim',
    action: 'Call booked',
    time: '1h ago',
    initials: 'DK',
    platform: 'FB'
  },
  {
    name: 'Emma Chen',
    action: 'Closed — $997',
    time: '3h ago',
    initials: 'EC',
    platform: 'IG'
  },
  {
    name: 'Brandon Clark',
    action: 'Closed — $1,997',
    time: '6h ago',
    initials: 'BC',
    platform: 'FB'
  }
];

export function RecentSales() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Activity</CardTitle>
        <CardDescription>Latest lead events from AI setter</CardDescription>
      </CardHeader>
      <CardContent>
        <div className='space-y-4'>
          {recentActivity.map((item, i) => (
            <div key={i} className='flex items-center gap-4'>
              <Avatar className='h-9 w-9'>
                <AvatarFallback className='bg-primary/10 text-primary text-xs'>
                  {item.initials}
                </AvatarFallback>
              </Avatar>
              <div className='flex-1 space-y-1'>
                <p className='text-sm leading-none font-medium'>
                  {item.name}
                  <span className='text-muted-foreground ml-2 text-xs'>
                    {item.platform}
                  </span>
                </p>
                <p className='text-muted-foreground text-xs'>{item.action}</p>
              </div>
              <div className='text-muted-foreground text-xs'>{item.time}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
