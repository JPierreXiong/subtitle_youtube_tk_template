import { and, eq, or, inArray } from 'drizzle-orm';

import { db } from '@/core/db';
import { mediaTasks } from '@/config/db/schema';
import { CreditStatus } from '@/shared/models/credit';
import { appendUserToResult, User } from '@/shared/models/user';

import { consumeCredits } from './credit';

export type MediaTask = typeof mediaTasks.$inferSelect & {
  user?: User;
};
export type NewMediaTask = typeof mediaTasks.$inferInsert;
export type UpdateMediaTask = Partial<
  Omit<NewMediaTask, 'id' | 'createdAt'>
>;

export type MediaTaskStatus =
  | 'pending'
  | 'extracting'
  | 'translating'
  | 'completed'
  | 'failed';

/**
 * Create a new media task with credit consumption
 */
export async function createMediaTask(
  newMediaTask: NewMediaTask,
  costCredits: number
) {
  const result = await db().transaction(async (tx: any) => {
    // 1. create media task record
    // Note: Credits are consumed in createAITask, not here
    // This prevents double deduction and ensures proper refund handling
    const [taskResult] = await tx
      .insert(mediaTasks)
      .values(newMediaTask)
      .returning();

    return taskResult;
  });

  return result;
}

/**
 * Find media task by ID
 */
export async function findMediaTaskById(id: string) {
  const [result] = await db()
    .select()
    .from(mediaTasks)
    .where(eq(mediaTasks.id, id));
  return result;
}

/**
 * Update media task by ID
 */
export async function updateMediaTaskById(
  id: string,
  updateMediaTask: UpdateMediaTask
) {
  const [result] = await db()
    .update(mediaTasks)
    .set(updateMediaTask)
    .where(eq(mediaTasks.id, id))
    .returning();

  return result;
}

/**
 * Check if user has active media task
 */
export async function hasActiveMediaTask(userId: string): Promise<boolean> {
  const [result] = await db()
    .select()
    .from(mediaTasks)
    .where(
      and(
        eq(mediaTasks.userId, userId),
        or(
          eq(mediaTasks.status, 'extracting'),
          eq(mediaTasks.status, 'translating')
        )
      )
    )
    .limit(1);

  return !!result;
}

/**
 * Get active media tasks for a user
 */
export async function getActiveMediaTasks(userId: string) {
  const result = await db()
    .select()
    .from(mediaTasks)
    .where(
      and(
        eq(mediaTasks.userId, userId),
        or(
          eq(mediaTasks.status, 'extracting'),
          eq(mediaTasks.status, 'translating')
        )
      )
    );

  return result;
}

