import path from 'node:path';
import { ClassroomSource } from './source.js';
export const name = 'zhiyun-classroom';
export const inject = ['profileContext'];
export async function apply(ctx) {
  // profileContext is owned by DSH, not a guessed global home/cwd.
  const source = new ClassroomSource({ sessionFile: path.join(ctx.profileContext.dir, 'data', 'zhiyun-classroom', 'session.dpapi') });
  await source.ready;
  ctx.provide('zhiyunClassroom', source);
  // No automatic login or credential loading when mounting the plugin.
  return () => source.dispose();
}
