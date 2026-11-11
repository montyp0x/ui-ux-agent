// How suites name a UI element. A leaf module (no engine imports) so audit
// configuration can use it without an import cycle through contracts.ts.
import { z } from 'zod';

export const targetSchema = z.discriminatedUnion('by', [
  z
    .object({
      by: z.literal('role'),
      role: z.enum([
        'button',
        'link',
        'textbox',
        'searchbox',
        'tab',
        'combobox',
        'heading',
        'dialog',
        'region',
        'checkbox',
        'radio',
        'menuitem',
        'option',
      ]),
      name: z.string().min(1),
    })
    .strict(),
  z.object({ by: z.literal('testId'), value: z.string().min(1) }).strict(),
  z.object({ by: z.literal('label'), value: z.string().min(1) }).strict(),
  z.object({ by: z.literal('placeholder'), value: z.string().min(1) }).strict(),
  z.object({ by: z.literal('css'), value: z.string().min(1) }).strict(),
]);
export type Target = z.infer<typeof targetSchema>;
