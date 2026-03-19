'use client';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {
  IconBell,
  IconCalendar,
  IconFlame,
  IconAlertTriangle,
  IconCheck
} from '@tabler/icons-react';
import { useNotifications } from '@/hooks/use-api';
import { markAllNotificationsRead } from '@/lib/api';

const typeIcons: Record<string, React.ReactNode> = {
  CALL_BOOKED: <IconCalendar className='h-4 w-4 text-blue-500' />,
  HOT_LEAD: <IconFlame className='h-4 w-4 text-orange-500' />,
  HUMAN_OVERRIDE_NEEDED: (
    <IconAlertTriangle className='h-4 w-4 text-yellow-500' />
  ),
  NO_SHOW: <IconAlertTriangle className='h-4 w-4 text-red-500' />,
  CLOSED_DEAL: <IconCheck className='h-4 w-4 text-green-500' />,
  NEW_LEAD: <IconFlame className='h-4 w-4 text-blue-500' />,
  SYSTEM: <IconCheck className='h-4 w-4 text-gray-500' />
};

function timeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function NotificationBell() {
  const { notifications, unreadCount, loading, refetch } = useNotifications();

  const handleMarkAllRead = async () => {
    try {
      // Mark all as read (no userId = mark all)
      await markAllNotificationsRead();
      refetch();
    } catch {
      // Silently fail -- notifications will be refetched on next open
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant='ghost' size='icon' className='relative'>
          <IconBell className='h-5 w-5' />
          {unreadCount > 0 && (
            <span className='bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold'>
              {unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-80'>
        <DropdownMenuLabel className='flex items-center justify-between'>
          <span>Notifications</span>
          {unreadCount > 0 && (
            <button
              onClick={handleMarkAllRead}
              className='text-primary text-xs font-normal hover:underline'
            >
              Mark all read
            </button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {loading ? (
          <div className='text-muted-foreground py-4 text-center text-sm'>
            Loading...
          </div>
        ) : notifications.length === 0 ? (
          <div className='text-muted-foreground py-4 text-center text-sm'>
            No notifications
          </div>
        ) : (
          notifications.map((n) => (
            <DropdownMenuItem
              key={n.id}
              className={`flex gap-3 p-3 ${!n.isRead ? 'bg-primary/5' : ''}`}
            >
              <div className='mt-0.5'>
                {typeIcons[n.type] || (
                  <IconCheck className='h-4 w-4 text-gray-500' />
                )}
              </div>
              <div className='flex-1 space-y-1'>
                <p className='text-sm leading-none font-medium'>{n.title}</p>
                <p className='text-muted-foreground text-xs'>{n.body}</p>
                <p className='text-muted-foreground text-[10px]'>
                  {timeAgo(n.createdAt)}
                </p>
              </div>
              {!n.isRead && (
                <div className='bg-primary mt-1 h-2 w-2 rounded-full' />
              )}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
