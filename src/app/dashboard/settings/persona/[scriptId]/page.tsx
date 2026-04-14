'use client';

import { use } from 'react';
import ScriptEditorView from '@/components/scripts/script-editor-view';

export default function ScriptEditorPage({
  params
}: {
  params: Promise<{ scriptId: string }>;
}) {
  const { scriptId } = use(params);

  return <ScriptEditorView scriptId={scriptId} />;
}
