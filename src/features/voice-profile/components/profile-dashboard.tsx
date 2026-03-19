'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api';
import {
  IconSparkles,
  IconRefresh,
  IconMessage,
  IconClock,
  IconMoodSmile,
  IconQuestionMark
} from '@tabler/icons-react';
import { toast } from 'sonner';

interface VoiceProfile {
  avgMessageLength: number;
  shortMessageRate: number;
  longMessageRate: number;
  avgWordsPerMessage: number;
  emojiFrequency: number;
  questionFrequency: number;
  exclamationFrequency: number;
  allCapsWordRate: number;
  topPhrases: string[];
  commonGreetings: string[];
  slangWords: string[];
  avgResponseTimeMinutes: number | null;
  peakActivityHours: number[];
  toneLabel: string;
  styleDescription: string;
  messageCount: number;
  generatedAt: string;
}

export function VoiceProfileDashboard() {
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const fetchProfile = useCallback(async () => {
    try {
      const data = await apiFetch<{ voiceProfile: VoiceProfile | null }>(
        '/settings/voice-profile'
      );
      setProfile(data.voiceProfile);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const data = await apiFetch<{ voiceProfile: VoiceProfile }>(
        '/settings/voice-profile',
        { method: 'POST' }
      );
      setProfile(data.voiceProfile);
      toast.success(
        `Voice profile generated from ${data.voiceProfile.messageCount} messages`
      );
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate profile');
    } finally {
      setGenerating(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className='h-6 w-48' />
          <Skeleton className='h-4 w-80' />
        </CardHeader>
        <CardContent>
          <Skeleton className='h-40 w-full' />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className='flex items-center justify-between'>
          <div>
            <CardTitle className='flex items-center gap-2'>
              <IconSparkles className='h-5 w-5 text-amber-500' />
              Creator DNA
            </CardTitle>
            <CardDescription>
              AI-generated communication style profile from your conversation
              history
            </CardDescription>
          </div>
          <Button
            onClick={handleGenerate}
            disabled={generating}
            variant={profile ? 'outline' : 'default'}
            size='sm'
          >
            {generating ? (
              <>
                <IconRefresh className='mr-1 h-4 w-4 animate-spin' />
                Analyzing...
              </>
            ) : profile ? (
              <>
                <IconRefresh className='mr-1 h-4 w-4' />
                Regenerate
              </>
            ) : (
              <>
                <IconSparkles className='mr-1 h-4 w-4' />
                Analyze My Style
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!profile ? (
          <div className='text-muted-foreground py-8 text-center'>
            <IconSparkles className='mx-auto mb-3 h-10 w-10 opacity-30' />
            <p className='text-sm'>No voice profile generated yet.</p>
            <p className='text-xs'>
              Click &quot;Analyze My Style&quot; to build your Creator DNA from
              conversation history.
            </p>
          </div>
        ) : (
          <div className='space-y-6'>
            {/* Tone Label & Description */}
            <div className='rounded-lg border bg-gradient-to-r from-amber-50 to-orange-50 p-4 dark:from-amber-950/20 dark:to-orange-950/20'>
              <div className='mb-2 flex items-center gap-2'>
                <Badge className='bg-amber-500 text-white'>
                  {profile.toneLabel}
                </Badge>
                <span className='text-muted-foreground text-xs'>
                  Based on {profile.messageCount} messages
                </span>
              </div>
              <p className='text-sm'>{profile.styleDescription}</p>
            </div>

            {/* Stats Grid */}
            <div className='grid grid-cols-2 gap-4 md:grid-cols-4'>
              <div className='rounded-lg border p-3 text-center'>
                <IconMessage className='text-muted-foreground mx-auto mb-1 h-4 w-4' />
                <p className='text-lg font-bold'>
                  {profile.avgWordsPerMessage}
                </p>
                <p className='text-muted-foreground text-[10px]'>
                  Avg words/msg
                </p>
              </div>
              <div className='rounded-lg border p-3 text-center'>
                <IconMoodSmile className='text-muted-foreground mx-auto mb-1 h-4 w-4' />
                <p className='text-lg font-bold'>{profile.emojiFrequency}</p>
                <p className='text-muted-foreground text-[10px]'>
                  Emojis per 100 words
                </p>
              </div>
              <div className='rounded-lg border p-3 text-center'>
                <IconQuestionMark className='text-muted-foreground mx-auto mb-1 h-4 w-4' />
                <p className='text-lg font-bold'>
                  {profile.questionFrequency}%
                </p>
                <p className='text-muted-foreground text-[10px]'>
                  Questions asked
                </p>
              </div>
              <div className='rounded-lg border p-3 text-center'>
                <IconClock className='text-muted-foreground mx-auto mb-1 h-4 w-4' />
                <p className='text-lg font-bold'>
                  {profile.avgResponseTimeMinutes ?? '—'}m
                </p>
                <p className='text-muted-foreground text-[10px]'>
                  Avg response time
                </p>
              </div>
            </div>

            {/* Message Length Distribution */}
            <div>
              <p className='mb-2 text-sm font-medium'>Message Length</p>
              <div className='space-y-2'>
                <div className='flex items-center gap-3'>
                  <span className='w-20 text-xs'>Short (&lt;50)</span>
                  <Progress
                    value={profile.shortMessageRate}
                    className='h-2 flex-1'
                  />
                  <span className='w-10 text-right text-xs tabular-nums'>
                    {profile.shortMessageRate}%
                  </span>
                </div>
                <div className='flex items-center gap-3'>
                  <span className='w-20 text-xs'>Medium</span>
                  <Progress
                    value={
                      100 - profile.shortMessageRate - profile.longMessageRate
                    }
                    className='h-2 flex-1'
                  />
                  <span className='w-10 text-right text-xs tabular-nums'>
                    {100 - profile.shortMessageRate - profile.longMessageRate}%
                  </span>
                </div>
                <div className='flex items-center gap-3'>
                  <span className='w-20 text-xs'>Long (&gt;200)</span>
                  <Progress
                    value={profile.longMessageRate}
                    className='h-2 flex-1'
                  />
                  <span className='w-10 text-right text-xs tabular-nums'>
                    {profile.longMessageRate}%
                  </span>
                </div>
              </div>
            </div>

            {/* Top Phrases & Slang */}
            <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
              {profile.topPhrases.length > 0 && (
                <div>
                  <p className='mb-2 text-sm font-medium'>Top Phrases</p>
                  <div className='flex flex-wrap gap-1.5'>
                    {profile.topPhrases.map((phrase) => (
                      <Badge
                        key={phrase}
                        variant='secondary'
                        className='text-xs'
                      >
                        {phrase}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {profile.slangWords.length > 0 && (
                <div>
                  <p className='mb-2 text-sm font-medium'>Slang & Informal</p>
                  <div className='flex flex-wrap gap-1.5'>
                    {profile.slangWords.map((word) => (
                      <Badge key={word} variant='outline' className='text-xs'>
                        {word}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Generated timestamp */}
            <p className='text-muted-foreground text-[10px]'>
              Generated{' '}
              {new Date(profile.generatedAt).toLocaleString('en-US', {
                dateStyle: 'medium',
                timeStyle: 'short'
              })}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
