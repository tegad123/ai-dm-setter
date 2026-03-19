import { IconBrandInstagram, IconBrandFacebook } from '@tabler/icons-react';

export function PlatformIcon({
  platform,
  className = 'h-4 w-4'
}: {
  platform: 'instagram' | 'facebook';
  className?: string;
}) {
  if (platform === 'instagram') {
    return <IconBrandInstagram className={`${className} text-pink-500`} />;
  }
  return <IconBrandFacebook className={`${className} text-blue-600`} />;
}
