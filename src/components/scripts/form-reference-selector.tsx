'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import type { ScriptForm } from '@/lib/script-types';

interface FormReferenceSelectorProps {
  forms: ScriptForm[];
  value: string | null;
  onChange: (formId: string | null) => void;
}

export default function FormReferenceSelector({
  forms,
  value,
  onChange
}: FormReferenceSelectorProps) {
  return (
    <Select value={value || ''} onValueChange={(v) => onChange(v || null)}>
      <SelectTrigger className='w-full'>
        <SelectValue placeholder='Select a form...' />
      </SelectTrigger>
      <SelectContent>
        {forms.map((form) => (
          <SelectItem key={form.id} value={form.id}>
            {form.name} ({form.fields.length} fields)
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
