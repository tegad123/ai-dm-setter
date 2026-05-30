import PageContainer from '@/components/layout/page-container';
import { CalendarAvailability } from '@/features/calendar/components/calendar-availability';

export const metadata = {
  title: 'Convlo — Calendar'
};

export default function CalendarPage() {
  return (
    <PageContainer
      scrollable
      pageTitle='Calendar'
      pageDescription='Your connected calendar availability for the next 7 days'
    >
      <CalendarAvailability />
    </PageContainer>
  );
}
