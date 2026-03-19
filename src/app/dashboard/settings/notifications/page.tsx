'use client';

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';

export default function NotificationSettingsPage() {
  return (
    <div className='flex flex-1 flex-col gap-6 p-4 md:p-6'>
      <div>
        <h2 className='text-2xl font-bold tracking-tight'>
          Notification Settings
        </h2>
        <p className='text-muted-foreground'>
          Configure how and when you receive notifications
        </p>
      </div>

      <Separator />

      <div className='grid gap-6'>
        <Card>
          <CardHeader>
            <CardTitle>Push Notifications</CardTitle>
            <CardDescription>
              Instant alerts for important events
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='flex items-center justify-between'>
              <Label htmlFor='call-booked' className='flex flex-col gap-1'>
                <span>Call Booked</span>
                <span className='text-muted-foreground text-sm font-normal'>
                  Get notified when a lead books a call
                </span>
              </Label>
              <Switch id='call-booked' defaultChecked />
            </div>
            <div className='flex items-center justify-between'>
              <Label htmlFor='hot-lead' className='flex flex-col gap-1'>
                <span>Hot Lead Detected</span>
                <span className='text-muted-foreground text-sm font-normal'>
                  AI identifies a high-intent lead
                </span>
              </Label>
              <Switch id='hot-lead' defaultChecked />
            </div>
            <div className='flex items-center justify-between'>
              <Label htmlFor='human-override' className='flex flex-col gap-1'>
                <span>Human Override Needed</span>
                <span className='text-muted-foreground text-sm font-normal'>
                  AI flags a conversation for manual review
                </span>
              </Label>
              <Switch id='human-override' defaultChecked />
            </div>
            <div className='flex items-center justify-between'>
              <Label htmlFor='no-show' className='flex flex-col gap-1'>
                <span>No Show Alert</span>
                <span className='text-muted-foreground text-sm font-normal'>
                  Lead missed their scheduled call
                </span>
              </Label>
              <Switch id='no-show' defaultChecked />
            </div>
            <div className='flex items-center justify-between'>
              <Label htmlFor='closed-deal' className='flex flex-col gap-1'>
                <span>Closed Deal</span>
                <span className='text-muted-foreground text-sm font-normal'>
                  Lead enrolled and paid
                </span>
              </Label>
              <Switch id='closed-deal' defaultChecked />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Email Reports</CardTitle>
            <CardDescription>
              Scheduled summary reports delivered to your inbox
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='flex items-center justify-between'>
              <Label htmlFor='daily-summary' className='flex flex-col gap-1'>
                <span>Daily Summary</span>
                <span className='text-muted-foreground text-sm font-normal'>
                  Total leads contacted, calls booked, pipeline snapshot — sent
                  every evening
                </span>
              </Label>
              <Switch id='daily-summary' defaultChecked />
            </div>
            <div className='flex items-center justify-between'>
              <Label htmlFor='weekly-report' className='flex flex-col gap-1'>
                <span>Weekly Report</span>
                <span className='text-muted-foreground text-sm font-normal'>
                  Full analytics summary — sent every Monday morning
                </span>
              </Label>
              <Switch id='weekly-report' defaultChecked />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
