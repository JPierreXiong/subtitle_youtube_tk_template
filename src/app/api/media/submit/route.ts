import { AIMediaType, AITaskStatus } from '@/extensions/ai';
import { db } from '@/core/db';
import { aiTask } from '@/config/db/schema';
import { eq } from 'drizzle-orm';
import { getUuid } from '@/shared/lib/hash';
import { respData, respErr } from '@/shared/lib/resp';
import { createAITask, NewAITask } from '@/shared/models/ai_task';
import { getRemainingCredits } from '@/shared/models/credit';
import {
  createMediaTask,
  hasActiveMediaTask,
  NewMediaTask,
} from '@/shared/models/media_task';
import { getUserInfo } from '@/shared/models/user';
import { getMediaProcessor, Platform } from '@/shared/services/media/processor';

export const maxDuration = 180; // Vercel 180 seconds limit

export async function POST(request: Request) {
  try {
    const { url, outputType, targetLang } = await request.json();

    if (!url) {
      throw new Error('URL is required');
    }

    // Get current user
    const user = await getUserInfo();
    if (!user) {
      throw new Error('no auth, please sign in');
    }

    // Check concurrent limit (1 active task per user)
    const hasActive = await hasActiveMediaTask(user.id);
    if (hasActive) {
      throw new Error(
        'You already have an active task. Please wait for it to complete.'
      );
    }

    // Detect platform
    let platform: Platform;
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      platform = 'youtube';
    } else if (url.includes('tiktok.com') || url.includes('vm.tiktok.com')) {
      platform = 'tiktok';
    } else {
      throw new Error('Invalid URL. Only YouTube and TikTok are supported.');
    }

    // Calculate cost credits
    // Original rule:
    // - Base subtitle extraction: 10 credits
    // - TikTok video download: 15 credits
    // - Subtitle extraction + AI translation: 15 credits (10 for extraction + 5 for translation)
    let costCredits = 10; // Base cost for subtitle extraction
    
    if (outputType === 'video' && platform === 'tiktok') {
      costCredits = 15; // Video download costs more
    } else if (targetLang && outputType !== 'video') {
      costCredits = 15; // Subtitle extraction (10) + Translation (5)
    }

    // Check credits
    const remainingCredits = await getRemainingCredits(user.id);
    if (remainingCredits < costCredits) {
      return respErr(`insufficient credits (required: ${costCredits}, available: ${remainingCredits})`);
    }

    // Create media task
    const mediaTaskId = getUuid();
    const newMediaTask: NewMediaTask = {
      id: mediaTaskId,
      userId: user.id,
      platform,
      videoUrl: url,
      status: 'pending',
      progress: 0,
    };

    await createMediaTask(newMediaTask, costCredits);

    // Create ai_task for Activity page integration
    // Note: Credits are consumed in createAITask
    // If createAITask fails, the transaction will rollback and credits won't be consumed
    const aiTaskId = getUuid();
    const newAITask: NewAITask = {
      id: aiTaskId,
      userId: user.id,
      mediaType: 'video_media', // Custom media type for media extraction
      provider: 'media-extractor',
      model: platform,
      prompt: url,
      scene: outputType === 'video' ? 'video-download' : 'subtitle-extraction',
      status: AITaskStatus.PENDING,
      costCredits,
      taskResult: JSON.stringify({ mediaTaskId }),
    };

    // Create ai_task - credits are consumed here
    // If this fails, the transaction will rollback automatically
    // If createMediaTask succeeded but createAITask fails, media_task will remain
    // but no credits will be consumed, so it's safe to leave it
    await createAITask(newAITask);

    // Start async processing (non-blocking)
    processMediaTask(mediaTaskId, platform, url, outputType, targetLang).catch(
      (error) => {
        console.error('Media processing failed:', error);
        // Error handling will be done in processMediaTask
      }
    );

    return respData({
      taskId: mediaTaskId,
      message: 'Processing started',
    });
  } catch (e: any) {
    console.log('media submit failed', e);
    return respErr(e.message);
  }
}

/**
 * Process media task asynchronously
 */
async function processMediaTask(
  taskId: string,
  platform: Platform,
  url: string,
  outputType: string,
  targetLang?: string
) {
  const { updateMediaTaskById } = await import('@/shared/models/media_task');
  const processor = await getMediaProcessor();

  try {
    // Update status to extracting
    await updateMediaTaskById(taskId, {
      status: 'extracting',
      progress: 10,
    });

    // Extract metadata and subtitles
    let metadata: any;
    let srtItems: any[];

    if (platform === 'youtube') {
      const videoId = processor.extractYouTubeId(url);
      if (!videoId) {
        throw new Error('Failed to extract YouTube video ID');
      }

      const result = await processor.extractYouTubeMetadata(videoId);
      metadata = result.metadata;
      srtItems = result.srtItems;
    } else {
      // TikTok
      const result = await processor.extractTikTokMetadata(url);
      metadata = result.metadata;
      srtItems = result.srtItems;
    }

    // Update progress
    await updateMediaTaskById(taskId, {
      ...metadata,
      sourceLang: metadata.sourceLang,
      progress: 40,
    });

    // Generate native SRT file
    const srtContent = processor.srtItemsToString(srtItems);
    const srtFileName = `native-${taskId}.srt`;
    const srtUrl = await processor.uploadSrtFile(srtContent, srtFileName);

    await updateMediaTaskById(taskId, {
      srtUrl,
      progress: 60,
    });

    // Handle translation if targetLang is provided
    if (targetLang && outputType !== 'video') {
      await updateMediaTaskById(taskId, {
        status: 'translating',
        targetLang,
        progress: 70,
      });

      const translatedSrtItems = await processor.translateSrtItems(
        srtItems,
        targetLang
      );
      const translatedSrtContent =
        processor.srtItemsToString(translatedSrtItems);
      const translatedSrtFileName = `translated-${taskId}-${targetLang}.srt`;
      const translatedSrtUrl = await processor.uploadSrtFile(
        translatedSrtContent,
        translatedSrtFileName
      );

      await updateMediaTaskById(taskId, {
        translatedSrtUrl,
        progress: 90,
      });
    }

    // Handle video download if requested (TikTok only)
    if (outputType === 'video' && platform === 'tiktok') {
      const videoBuffer = await processor.downloadTikTokVideo(url);
      const videoFileName = `video-${taskId}.mp4`;
      const videoUrl = await processor.uploadVideoFile(
        videoBuffer,
        videoFileName
      );

      await updateMediaTaskById(taskId, {
        resultVideoUrl: videoUrl,
        progress: 95,
      });
    }

    // Mark as completed
    await updateMediaTaskById(taskId, {
      status: 'completed',
      progress: 100,
    });
  } catch (error: any) {
    console.error('Media processing error:', error);

    // Update task as failed
    await updateMediaTaskById(taskId, {
      status: 'failed',
      errorMessage: error.message || 'Unknown error',
    });

    // Refund credits through ai_task
    await refundMediaTaskCredits(taskId);
  }
}

/**
 * Refund credits for failed media task
 * Credits are refunded through the associated ai_task record
 */
async function refundMediaTaskCredits(mediaTaskId: string) {
  try {
    const { findAITaskById, updateAITaskById } = await import(
      '@/shared/models/ai_task'
    );
    const { AITaskStatus } = await import('@/extensions/ai');

    // Find associated ai_task by mediaTaskId in taskResult
    // Search for ai_task where taskResult contains the mediaTaskId
    const allAiTasks = await db()
      .select()
      .from(aiTask)
      .where(eq(aiTask.mediaType, 'video_media'));

    type AiTaskSelect = typeof aiTask.$inferSelect;
    const aiTasks = allAiTasks.filter((task: AiTaskSelect) => {
      if (!task.taskResult) return false;
      try {
        const result = JSON.parse(task.taskResult);
        return result.mediaTaskId === mediaTaskId;
      } catch {
        return false;
      }
    });

    if (aiTasks.length === 0) {
      console.warn(`No ai_task found for media_task ${mediaTaskId}`);
      return;
    }

    const aiTaskRecord = aiTasks[0];

    // Update ai_task status to failed, which will trigger credit refund
    await updateAITaskById(aiTaskRecord.id, {
      status: AITaskStatus.FAILED,
      creditId: aiTaskRecord.creditId,
    });
  } catch (refundError: any) {
    console.error('Failed to refund credits:', refundError);
    // Don't throw - we've already marked the task as failed
  }
}

