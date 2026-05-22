import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCreditCard,
  IconFile,
  IconFileText,
  IconHelpCircle,
  IconPhoto,
  IconDeviceLaptop,
  IconLayoutDashboard,
  IconLoader2,
  IconLogin,
  IconProps,
  IconShoppingBag,
  IconMoon,
  IconDotsVertical,
  IconPizza,
  IconPlus,
  IconSettings,
  IconSun,
  IconTrash,
  IconBrandTwitter,
  IconUser,
  IconUserCircle,
  IconUserEdit,
  IconUserX,
  IconX,
  IconLayoutKanban,
  IconBrandGithub,
  IconFolder,
  IconUsers,
  IconCrown,
  IconStar,
  IconBox,
  IconPalette,
  IconMessageCircle,
  IconChartBar,
  IconBell,
  IconBrandInstagram,
  IconBrandFacebook,
  IconMicrophone
} from '@tabler/icons-react';

export type Icon = React.ComponentType<IconProps>;

// Convlo brand mark — an open "C" ring (currentColor, adapts to theme) with a
// brand-blue dot in the aperture. Replaces the old placeholder IconCommand.
const ConvloMark = ({ size = 24, className }: IconProps) => (
  <svg
    xmlns='http://www.w3.org/2000/svg'
    width={size}
    height={size}
    viewBox='0 0 24 24'
    fill='none'
    className={className}
  >
    <path
      d='M17.6 6.7 A 7.8 7.8 0 1 0 17.6 17.3'
      stroke='currentColor'
      strokeWidth='3'
      strokeLinecap='round'
    />
    <circle cx='12.3' cy='12' r='2' fill='#3B82F6' />
  </svg>
);

export const Icons = {
  dashboard: IconLayoutDashboard,
  logo: ConvloMark,
  login: IconLogin,
  close: IconX,
  product: IconBox,
  palette: IconPalette,
  spinner: IconLoader2,
  kanban: IconLayoutKanban,
  chevronLeft: IconChevronLeft,
  chevronRight: IconChevronRight,
  trash: IconTrash,
  employee: IconUserX,
  post: IconFileText,
  page: IconFile,
  userPen: IconUserEdit,
  user2: IconUserCircle,
  media: IconPhoto,
  settings: IconSettings,
  billing: IconCreditCard,
  ellipsis: IconDotsVertical,
  add: IconPlus,
  warning: IconAlertTriangle,
  user: IconUser,
  arrowRight: IconArrowRight,
  help: IconHelpCircle,
  pizza: IconPizza,
  sun: IconSun,
  moon: IconMoon,
  laptop: IconDeviceLaptop,
  github: IconBrandGithub,
  twitter: IconBrandTwitter,
  check: IconCheck,
  workspace: IconFolder,
  teams: IconUsers,
  pro: IconCrown,
  exclusive: IconStar,
  account: IconUserCircle,
  profile: IconUser,
  // Custom icons
  leads: IconUsers,
  conversations: IconMessageCircle,
  analytics: IconChartBar,
  notifications: IconBell,
  instagram: IconBrandInstagram,
  facebook: IconBrandFacebook,
  voiceNotes: IconMicrophone
};
