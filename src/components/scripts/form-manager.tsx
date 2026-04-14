'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Plus,
  Trash2,
  FileText,
  ChevronDown,
  ChevronRight
} from 'lucide-react';
import FormFieldEditor from './form-field-editor';
import {
  createForm,
  updateForm,
  deleteForm,
  createFormField,
  updateFormField,
  deleteFormField
} from '@/lib/api';
import type { ScriptForm } from '@/lib/script-types';
import { toast } from 'sonner';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@/components/ui/collapsible';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog';

interface FormManagerProps {
  forms: ScriptForm[];
  scriptId: string;
  onFormsChange: (forms: ScriptForm[]) => void;
}

export default function FormManager({
  forms,
  scriptId,
  onFormsChange
}: FormManagerProps) {
  const [openForms, setOpenForms] = useState<Set<string>>(new Set());

  const toggleForm = (formId: string) => {
    setOpenForms((prev) => {
      const next = new Set(prev);
      if (next.has(formId)) next.delete(formId);
      else next.add(formId);
      return next;
    });
  };

  const handleCreateForm = async () => {
    try {
      const result = await createForm(scriptId, {
        name: 'New Form',
        description: ''
      });
      const newForm = { ...result, fields: result.fields || [] };
      onFormsChange([...forms, newForm]);
      setOpenForms((prev) => new Set(prev).add(newForm.id));
    } catch {
      toast.error('Failed to create form');
    }
  };

  const handleUpdateForm = async (
    formId: string,
    data: { name?: string; description?: string }
  ) => {
    try {
      await updateForm(scriptId, formId, data);
      onFormsChange(
        forms.map((f) => (f.id === formId ? { ...f, ...data } : f))
      );
    } catch {
      toast.error('Failed to update form');
    }
  };

  const handleDeleteForm = async (formId: string) => {
    try {
      await deleteForm(scriptId, formId);
      onFormsChange(forms.filter((f) => f.id !== formId));
    } catch {
      toast.error('Failed to delete form');
    }
  };

  const handleAddField = async (formId: string) => {
    try {
      const result = await createFormField(scriptId, formId, {
        fieldLabel: '',
        fieldValue: ''
      });
      onFormsChange(
        forms.map((f) =>
          f.id === formId ? { ...f, fields: [...f.fields, result] } : f
        )
      );
    } catch {
      toast.error('Failed to add field');
    }
  };

  const handleSaveField = async (
    formId: string,
    fieldId: string,
    data: { fieldLabel?: string; fieldValue?: string }
  ) => {
    try {
      await updateFormField(scriptId, formId, fieldId, data);
      onFormsChange(
        forms.map((f) =>
          f.id === formId
            ? {
                ...f,
                fields: f.fields.map((fld) =>
                  fld.id === fieldId ? { ...fld, ...data } : fld
                )
              }
            : f
        )
      );
    } catch {
      toast.error('Failed to save field');
    }
  };

  const handleDeleteField = async (formId: string, fieldId: string) => {
    try {
      await deleteFormField(scriptId, formId, fieldId);
      onFormsChange(
        forms.map((f) =>
          f.id === formId
            ? { ...f, fields: f.fields.filter((fld) => fld.id !== fieldId) }
            : f
        )
      );
    } catch {
      toast.error('Failed to delete field');
    }
  };

  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between'>
        <Label className='text-sm font-medium'>Forms & Data</Label>
        <Button variant='outline' size='sm' onClick={handleCreateForm}>
          <Plus className='mr-1 h-3 w-3' />
          Add Form
        </Button>
      </div>

      {forms.length === 0 && (
        <p className='text-muted-foreground text-sm italic'>
          No forms yet. Forms are used for FAQ answers, data sheets, etc.
        </p>
      )}

      {forms.map((form) => (
        <Collapsible
          key={form.id}
          open={openForms.has(form.id)}
          onOpenChange={() => toggleForm(form.id)}
        >
          <div className='border-border rounded border'>
            <div className='flex items-center gap-2 p-3'>
              <CollapsibleTrigger className='flex flex-1 items-center gap-1 text-left'>
                {openForms.has(form.id) ? (
                  <ChevronDown className='text-muted-foreground h-4 w-4' />
                ) : (
                  <ChevronRight className='text-muted-foreground h-4 w-4' />
                )}
                <FileText className='h-4 w-4 text-amber-500' />
                <span className='text-sm font-medium'>{form.name}</span>
                <span className='text-muted-foreground ml-2 text-xs'>
                  ({form.fields.length} fields)
                </span>
              </CollapsibleTrigger>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant='ghost' size='icon' className='h-7 w-7'>
                    <Trash2 className='h-3.5 w-3.5 text-red-500' />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete Form</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will delete &ldquo;{form.name}&rdquo; and all its
                      fields. Actions referencing this form will be unlinked.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => handleDeleteForm(form.id)}
                      className='bg-red-600 hover:bg-red-700'
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>

            <CollapsibleContent className='border-border space-y-3 border-t p-3'>
              <div>
                <Label className='text-xs'>Form Name</Label>
                <Input
                  defaultValue={form.name}
                  onBlur={(e) => {
                    if (e.target.value !== form.name) {
                      handleUpdateForm(form.id, { name: e.target.value });
                    }
                  }}
                  className='text-sm'
                />
              </div>

              <div className='space-y-2'>
                <Label className='text-xs'>Fields (Q&A Pairs)</Label>
                {form.fields.map((field) => (
                  <FormFieldEditor
                    key={field.id}
                    field={field}
                    onSave={(fid, data) => handleSaveField(form.id, fid, data)}
                    onDelete={(fid) => handleDeleteField(form.id, fid)}
                  />
                ))}
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => handleAddField(form.id)}
                >
                  <Plus className='mr-1 h-3 w-3' />
                  Add Field
                </Button>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      ))}
    </div>
  );
}
