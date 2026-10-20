import type { PushNotice } from './services/push.js';

/** The assignee's push about a to-do coming due (ADR-0026): its title, opening Home. */
export function taskDuePush(title: string, taskId: string): PushNotice {
  return { title: 'To-do due', body: title.slice(0, 200), url: '/', tag: `task-${taskId}` };
}
