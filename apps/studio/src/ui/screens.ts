import type { ComponentProps } from 'react';
import { lazyScreen } from './lazyScreen';
import type { ConnectSection as ConnectSectionType } from './ConnectSection';

/** S1-3: every screen but Home, each in its own chunk (see lazyScreen.tsx). Home and the shell are in the first chunk. */
export const ActivitySection = lazyScreen(() => import('./ActivitySection').then((m) => m.ActivitySection));
export const ConnectSection = lazyScreen<NonNullable<ComponentProps<typeof ConnectSectionType>>>(() =>
  import('./ConnectSection').then((m) => m.ConnectSection),
);
export const WhatXoKnows = lazyScreen(() => import('./WhatXoKnows').then((m) => m.WhatXoKnows));
export const KnowledgeSection = lazyScreen(() => import('./KnowledgeSection').then((m) => m.KnowledgeSection));
export const ContextSection = lazyScreen(() => import('./ContextSection').then((m) => m.ContextSection));
export const TasksSection = lazyScreen(() => import('./TasksSection').then((m) => m.TasksSection));
export const WorkSection = lazyScreen(() => import('./WorkSection').then((m) => m.WorkSection));
export const ProcessesSection = lazyScreen(() => import('./ProcessesSection').then((m) => m.ProcessesSection));
export const ContractsSection = lazyScreen(() => import('./ContractsSection').then((m) => m.ContractsSection));
export const PlatformSection = lazyScreen(() => import('./PlatformSection').then((m) => m.PlatformSection));
export const WorkspacesSection = lazyScreen(() => import('./WorkspacesSection').then((m) => m.WorkspacesSection));
export const ReviewSection = lazyScreen(() => import('./ReviewSection').then((m) => m.ReviewSection));
export const XosSection = lazyScreen(() => import('./XosSection').then((m) => m.XosSection));
export const LibraryScreen = lazyScreen(() => import('./LibraryScreen').then((m) => m.LibraryScreen));
export const AuditScreen = lazyScreen(() => import('./AuditScreen').then((m) => m.AuditScreen));
export const SettingsScreen = lazyScreen(() => import('./SettingsScreen').then((m) => m.SettingsScreen));
export const ChatScreen = lazyScreen(() => import('./ChatScreen').then((m) => m.ChatScreen));
export const WorkflowEditor = lazyScreen(() => import('./WorkflowScreen').then((m) => m.WorkflowEditor));
export const CreateXo = lazyScreen(() => import('./CreateXo').then((m) => m.CreateXo));
export const XoInspector = lazyScreen(() => import('./XoInspector').then((m) => m.XoInspector));
