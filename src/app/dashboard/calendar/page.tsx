import PageContainer from '@/components/layout/page-container';
import { CalendarWeekGrid } from '@/features/calendar/components/calendar-week-grid';

export const metadata = {
  title: 'Convlo — Calendar'
};

export default function CalendarPage() {
  return (
    <PageContainer
      scrollable
      pageTitle='Calendar'
      pageDescription='Your connected calendar availability, week by week'
    >
      <CalendarWeekGrid />
    </PageContainer>
  );
}
