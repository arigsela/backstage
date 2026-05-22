import { scaffolderPlugin } from '@backstage/plugin-scaffolder';
import { createScaffolderFieldExtension } from '@backstage/plugin-scaffolder-react';
import { KagentSuggestField } from './KagentSuggestField';

export const KagentSuggestFieldExtension = scaffolderPlugin.provide(
  createScaffolderFieldExtension({
    component: KagentSuggestField as any,
    name: 'KagentSuggest',
  }),
);
