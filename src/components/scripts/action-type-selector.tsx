'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  SCRIPT_ACTION_TYPE_LABELS,
  type ScriptActionType
} from '@/lib/script-types';

interface ActionTypeSelectorProps {
  value: ScriptActionType;
  onChange: (value: ScriptActionType) => void;
  disabled?: boolean;
}

const ACTION_TYPE_ORDER: ScriptActionType[] = [
  'send_message',
  'ask_question',
  'send_voice_note',
  'send_link',
  'send_video',
  'form_reference',
  'runtime_judgment',
  'wait_for_response',
  'wait_duration'
];

export default function ActionTypeSelector({
  value,
  onChange,
  disabled
}: ActionTypeSelectorProps) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v as ScriptActionType)}
      disabled={disabled}
    >
      <SelectTrigger className='w-[180px]'>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ACTION_TYPE_ORDER.map((type) => (
          <SelectItem key={type} value={type}>
            {SCRIPT_ACTION_TYPE_LABELS[type]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
