'use client';

import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';
import type { ScriptFormField } from '@/lib/script-types';

interface FormFieldEditorProps {
  field: ScriptFormField;
  onSave: (
    fieldId: string,
    data: { fieldLabel?: string; fieldValue?: string }
  ) => void;
  onDelete: (fieldId: string) => void;
}

export default function FormFieldEditor({
  field,
  onSave,
  onDelete
}: FormFieldEditorProps) {
  return (
    <div className='border-border flex items-start gap-2 rounded border p-2'>
      <div className='flex-1 space-y-1'>
        <Input
          defaultValue={field.fieldLabel}
          placeholder='Question / Label'
          className='text-sm font-medium'
          onBlur={(e) => {
            if (e.target.value !== field.fieldLabel) {
              onSave(field.id, { fieldLabel: e.target.value });
            }
          }}
        />
        <Textarea
          defaultValue={field.fieldValue || ''}
          placeholder='Answer / Value (fill in later)'
          className='min-h-[40px] text-sm'
          onBlur={(e) => {
            if (e.target.value !== (field.fieldValue || '')) {
              onSave(field.id, { fieldValue: e.target.value });
            }
          }}
        />
      </div>
      <Button
        variant='ghost'
        size='icon'
        className='mt-1 h-7 w-7 shrink-0'
        onClick={() => onDelete(field.id)}
      >
        <Trash2 className='h-3.5 w-3.5 text-red-500' />
      </Button>
    </div>
  );
}
