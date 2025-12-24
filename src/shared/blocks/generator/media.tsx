'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle,
  CreditCard,
  Download,
  Loader2,
  User,
  Video,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Link } from '@/core/i18n/navigation';
import { Button } from '@/shared/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { Progress } from '@/shared/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select';
import { useAppContext } from '@/shared/contexts/app';
import { cn } from '@/shared/lib/utils';

interface MediaExtractorProps {
  srOnlyTitle?: string;
  className?: string;
}

interface MediaTaskStatus {
  id: string;
  status: 'pending' | 'extracting' | 'translating' | 'completed' | 'failed';
  progress: number;
  srtUrl?: string;
  translatedSrtUrl?: string;
  resultVideoUrl?: string;
  errorMessage?: string;
  sourceLang?: string;
  targetLang?: string;
  title?: string;
  platform?: string;
}

const POLL_INTERVAL = 3000; // 3 seconds
const GENERATION_TIMEOUT = 180000; // 3 minutes

const TARGET_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: 'Chinese (Simplified)' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ru', label: 'Russian' },
  { value: 'it', label: 'Italian' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hi', label: 'Hindi' },
];

export function MediaExtractor({
  className,
  srOnlyTitle,
}: MediaExtractorProps) {
  const t = useTranslations('ai.media');
  const { user, isCheckSign, setIsShowSignModal, fetchUserCredits } =
    useAppContext();

  // Form state
  const [url, setUrl] = useState('');
  const [targetLang, setTargetLang] = useState<string>('');
  const [outputType, setOutputType] = useState<'subtitle' | 'video'>(
    'subtitle'
  );

  // Generation state
  const [isExtracting, setIsExtracting] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [taskStatus, setTaskStatus] = useState<MediaTaskStatus | null>(null);
  const [generationStartTime, setGenerationStartTime] = useState<number | null>(
    null
  );

  // Poll task status recursively
  const pollTaskStatus = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        // Check timeout
        if (generationStartTime) {
          const elapsedTime = Date.now() - generationStartTime;
          if (elapsedTime > GENERATION_TIMEOUT) {
            setIsExtracting(false);
            setGenerationStartTime(null);
            toast.error('Extraction timed out. Please try again.');
            return true; // Stop polling
          }
        }

        // Request API to query task
        const resp = await fetch(`/api/media/status?id=${id}`, {
          method: 'GET',
        });

        if (!resp.ok) {
          throw new Error(`request failed with status: ${resp.status}`);
        }

        const { code, message, data } = await resp.json();
        if (code !== 0) {
          throw new Error(message || 'Query task failed');
        }

        const task = data as MediaTaskStatus;
        setTaskStatus(task);
        setProgress(task.progress || 0);

        // Handle final states
        if (task.status === 'completed') {
          setIsExtracting(false);
          setGenerationStartTime(null);
          toast.success('Extraction completed successfully!');
          fetchUserCredits();
          return true; // Stop polling
        }

        if (task.status === 'failed') {
          setIsExtracting(false);
          setGenerationStartTime(null);
          toast.error(
            `Extraction failed: ${task.errorMessage || 'Unknown error'}`
          );
          fetchUserCredits();
          return true; // Stop polling
        }

        // Continue polling
        return false;
      } catch (error: any) {
        console.error('Error polling task:', error);
        setIsExtracting(false);
        setProgress(0);
        setGenerationStartTime(null);
        toast.error('Failed to query task status: ' + error.message);
        fetchUserCredits();
        return true; // Stop polling on error
      }
    },
    [generationStartTime, fetchUserCredits]
  );

  // Start task polling with recursive setTimeout
  useEffect(() => {
    if (taskId && isExtracting) {
      let timeoutId: NodeJS.Timeout;

      const poll = async () => {
        const completed = await pollTaskStatus(taskId);
        if (!completed) {
          timeoutId = setTimeout(poll, POLL_INTERVAL);
        }
      };

      timeoutId = setTimeout(poll, POLL_INTERVAL);

      return () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      };
    }
  }, [taskId, isExtracting, pollTaskStatus]);

  const handleExtract = async () => {
    if (!user) {
      setIsShowSignModal(true);
      return;
    }

    if (!url.trim()) {
      toast.error('Please enter a video URL');
      return;
    }

    // Validate URL
    const isValidUrl =
      url.includes('youtube.com') ||
      url.includes('youtu.be') ||
      url.includes('tiktok.com') ||
      url.includes('vm.tiktok.com');

    if (!isValidUrl) {
      toast.error(t('extractor.invalid_url'));
      return;
    }

    // Validate output type
    if (outputType === 'video') {
      const isTikTok = url.includes('tiktok.com') || url.includes('vm.tiktok.com');
      if (!isTikTok) {
        toast.error('Video download is only available for TikTok videos');
        return;
      }
    }

    // Check credits before submission
    // Original rule:
    // - Base subtitle extraction: 10 credits
    // - TikTok video download: 15 credits
    // - Subtitle extraction + AI translation: 15 credits (10 + 5)
    if (user) {
      let requiredCredits = 10; // Base cost for subtitle extraction
      
      if (outputType === 'video') {
        const isTikTok = url.includes('tiktok.com') || url.includes('vm.tiktok.com');
        if (isTikTok) {
          requiredCredits = 15; // Video download costs more
        }
      } else if (targetLang) {
        requiredCredits = 15; // Subtitle extraction (10) + Translation (5)
      }
      
      // Get user credits - try multiple ways to access credits
      let userCredits = 0;
      if (user.credits) {
        if (typeof user.credits === 'object' && 'remainingCredits' in user.credits) {
          userCredits = user.credits.remainingCredits || 0;
        } else if (typeof user.credits === 'number') {
          userCredits = user.credits;
        }
      }
      
      // Debug log
      console.log('Credit check:', { userCredits, requiredCredits, userCreditsObj: user.credits });
      
      // Explicit check: userCredits must be >= requiredCredits
      if (userCredits < requiredCredits) {
        console.error('Insufficient credits detected:', { userCredits, requiredCredits });
        toast.error(t('extractor.insufficient_credits') + ` (需要 ${requiredCredits} 积分，当前 ${userCredits} 积分)`);
        // Refresh credits to ensure we have the latest data
        try {
          await fetchUserCredits();
        } catch (e) {
          console.error('Failed to refresh credits:', e);
        }
        return;
      }
      
      // Log success before proceeding
      console.log('Credit check passed, proceeding with extraction');
    }

    setIsExtracting(true);
    setProgress(0);
    setTaskStatus(null);
    setGenerationStartTime(Date.now());

    try {
      const resp = await fetch('/api/media/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: url.trim(),
          outputType,
          targetLang: outputType === 'subtitle' && targetLang ? targetLang : undefined,
        }),
      });

      if (!resp.ok) {
        throw new Error(`request failed with status: ${resp.status}`);
      }

      const { code, message, data } = await resp.json();
      if (code !== 0) {
        console.error('API returned error:', { code, message });
        // Check if it's an insufficient credits error
        if (message && message.toLowerCase().includes('insufficient credits')) {
          console.error('Backend insufficient credits error:', message);
          toast.error(t('extractor.insufficient_credits') + ` (后端错误: ${message})`);
        } else {
          toast.error(message || t('extractor.error_message', { message: 'Extraction failed' }));
        }
        throw new Error(message || 'Extraction failed');
      }
      
      console.log('Task submitted successfully:', data.taskId);

      setTaskId(data.taskId);
      setProgress(10);
    } catch (error: any) {
      console.error('Extraction error:', error);
      setIsExtracting(false);
      setProgress(0);
      setGenerationStartTime(null);
      
      // Check if it's an insufficient credits error
      const errorMessage = error.message || '';
      if (errorMessage.toLowerCase().includes('insufficient credits')) {
        toast.error(t('extractor.insufficient_credits'));
      } else {
        toast.error('Failed to start extraction: ' + errorMessage);
      }
      
      fetchUserCredits();
    }
  };

  const getStatusText = () => {
    if (!taskStatus) return '';
    switch (taskStatus.status) {
      case 'extracting':
        return 'Extracting subtitles...';
      case 'translating':
        return 'Translating subtitles...';
      case 'completed':
        return 'Completed';
      case 'failed':
        return 'Failed';
      default:
        return 'Processing...';
    }
  };

  const handleDownload = (url: string, filename: string) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <Card className={cn('w-full', className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Video className="h-5 w-5" />
          {srOnlyTitle ? (
            <span className="sr-only">{srOnlyTitle}</span>
          ) : (
            t('extractor.title')
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* URL Input */}
        <div className="space-y-2">
          <Label htmlFor="media-url">{t('extractor.url_label')}</Label>
          <div className="flex gap-2">
            <Input
              id="media-url"
              type="url"
              placeholder={t('extractor.url_placeholder')}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={isExtracting}
              className="flex-1"
            />
            {url && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setUrl('')}
                disabled={isExtracting}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {/* Source Language (Read-only) */}
        {taskStatus?.sourceLang && (
          <div className="space-y-2">
            <Label>{t('extractor.source_lang_label')}</Label>
            <Input
              value={TARGET_LANGUAGES.find((l) => l.value === taskStatus.sourceLang)?.label || taskStatus.sourceLang}
              disabled
              className="bg-muted"
            />
          </div>
        )}

        {/* Target Language Select */}
        {outputType === 'subtitle' && (
          <div className="space-y-2">
            <Label htmlFor="target-lang">{t('extractor.target_lang_label')}</Label>
            <Select
              value={targetLang}
              onValueChange={setTargetLang}
              disabled={isExtracting}
            >
              <SelectTrigger id="target-lang">
                <SelectValue placeholder={t('extractor.target_lang_placeholder')} />
              </SelectTrigger>
              <SelectContent>
                {TARGET_LANGUAGES.map((lang) => (
                  <SelectItem key={lang.value} value={lang.value}>
                    {lang.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Output Type Select */}
        <div className="space-y-2">
          <Label htmlFor="output-type">{t('extractor.output_type_label')}</Label>
          <Select
            value={outputType}
            onValueChange={(value) =>
              setOutputType(value as 'subtitle' | 'video')
            }
            disabled={isExtracting}
          >
            <SelectTrigger id="output-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="subtitle">{t('extractor.output_type_subtitle')}</SelectItem>
              <SelectItem value="video">{t('extractor.output_type_video')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Cost Info */}
        {user && (
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground text-center">
              {t('extractor.cost_info')}
            </p>
          </div>
        )}

        {/* Extract Button */}
        {!user ? (
          <Button
            onClick={() => setIsShowSignModal(true)}
            className="w-full"
            size="lg"
          >
            <User className="mr-2 h-4 w-4" />
            {t('extractor.sign_in_to_extract')}
          </Button>
        ) : (
          <Button
            onClick={handleExtract}
            disabled={isExtracting || !url.trim()}
            className="w-full"
            size="lg"
          >
            {isExtracting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {getStatusText()}
              </>
            ) : (
              <>
                <Video className="mr-2 h-4 w-4" />
                {t('extractor.extract')}
              </>
            )}
          </Button>
        )}

        {/* Progress Bar */}
        {isExtracting && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {t('extractor.extraction_progress')}
              </span>
              <span className="font-medium">{progress}%</span>
            </div>
            <Progress value={progress} />
            <p className="text-xs text-muted-foreground">
              {taskStatus?.status === 'translating'
                ? t('extractor.translation_time_cost')
                : t('extractor.time_cost')}
            </p>
          </div>
        )}

        {/* Results */}
        {taskStatus?.status === 'completed' && (
          <div className="space-y-4 rounded-lg border bg-muted/50 p-4">
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle className="h-5 w-5" />
              <span className="font-medium">{t('extractor.completed')}</span>
            </div>

            {taskStatus.title && (
              <div>
                <p className="text-sm font-medium">{taskStatus.title}</p>
                {taskStatus.platform && (
                  <p className="text-xs text-muted-foreground">
                    Platform: {taskStatus.platform}
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {taskStatus.srtUrl && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    handleDownload(
                      taskStatus.srtUrl!,
                      `native-subtitle-${taskStatus.id}.srt`
                    )
                  }
                >
                  <Download className="mr-2 h-4 w-4" />
                  {t('extractor.download_native_srt')}
                </Button>
              )}

              {taskStatus.translatedSrtUrl && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    handleDownload(
                      taskStatus.translatedSrtUrl!,
                      `translated-subtitle-${taskStatus.id}-${taskStatus.targetLang}.srt`
                    )
                  }
                >
                  <Download className="mr-2 h-4 w-4" />
                  {t('extractor.download_translated_srt')}
                </Button>
              )}

              {taskStatus.resultVideoUrl && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    handleDownload(
                      taskStatus.resultVideoUrl!,
                      `video-${taskStatus.id}.mp4`
                    )
                  }
                >
                  <Download className="mr-2 h-4 w-4" />
                  {t('extractor.download_video')}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Error Display */}
        {taskStatus?.status === 'failed' && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="text-sm text-red-600">
              {t('extractor.error_message', { message: taskStatus.errorMessage || 'Unknown error' })}
            </p>
          </div>
        )}

        {/* Credits Info */}
        {user && (
          <div className="flex items-center justify-between rounded-lg border bg-muted/50 p-3 text-sm">
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">
                {t('extractor.credits_remaining', {
                  credits: typeof user.credits === 'object' && user.credits !== null && 'remainingCredits' in user.credits
                    ? user.credits.remainingCredits
                    : typeof user.credits === 'number'
                    ? user.credits
                    : 0
                })}
              </span>
            </div>
            <Link href="/settings/credits">
              <Button variant="link" size="sm" className="h-auto p-0">
                {t('extractor.buy_credits')}
              </Button>
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

