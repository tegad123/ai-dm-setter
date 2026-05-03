import { redirect } from 'next/navigation';

export default async function PipelineShortcutPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string | string[]; search?: string | string[] }>;
}) {
  const params = await searchParams;
  const rawQuery = params.q ?? params.search;
  const query = Array.isArray(rawQuery) ? rawQuery[0] : rawQuery;
  const suffix = query ? `?q=${encodeURIComponent(query)}` : '';

  redirect(`/dashboard/leads${suffix}`);
}
