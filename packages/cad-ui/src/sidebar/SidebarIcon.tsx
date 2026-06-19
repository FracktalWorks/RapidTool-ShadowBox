/**
 * Sidebar Icon Components
 * 
 * Reusable icon button components for sidebars and toolbars.
 * Designed to work across different internal projects with flexible styling.
 * 
 * @module @rapidtool/cad-ui/sidebar
 * 
 * @example
 * // Basic usage
 * <SidebarIcon
 *   icon={<HomeIcon />}
 *   label="Home"
 *   onClick={() => navigate('/')}
 * />
 * 
 * @example
 * // With badge and active state
 * <SidebarIcon
 *   icon={<NotificationIcon />}
 *   label="Notifications"
 *   badge={5}
 *   active
 *   onClick={handleNotifications}
 * />
 * 
 * @example
 * // Icon group
 * <SidebarIconGroup>
 *   <SidebarIcon icon={<Icon1 />} label="Item 1" />
 *   <SidebarIcon icon={<Icon2 />} label="Item 2" />
 *   <SidebarDivider />
 *   <SidebarIcon icon={<Icon3 />} label="Item 3" />
 * </SidebarIconGroup>
 */

import React from 'react';

// ============================================================================
// Types
// ============================================================================

export type SidebarIconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type SidebarIconVariant = 'default' | 'ghost' | 'outline' | 'filled';

export interface SidebarIconProps {
  /** Icon element (React node - use any icon library) */
  icon: React.ReactNode;
  /** Accessible label (used for aria-label and tooltip) */
  label: string;
  /** Custom tooltip text (defaults to label) */
  tooltip?: string;
  /** Whether the icon is in active/selected state */
  active?: boolean;
  /** Whether the icon is disabled */
  disabled?: boolean;
  /** Badge content (number or string) */
  badge?: string | number;
  /** Badge variant for styling */
  badgeVariant?: 'default' | 'destructive' | 'warning' | 'success';
  /** Size variant */
  size?: SidebarIconSize;
  /** Style variant */
  variant?: SidebarIconVariant;
  /** Click handler */
  onClick?: (event: React.MouseEvent) => void;
  /** Additional CSS classes */
  className?: string;
  /** Additional inline styles */
  style?: React.CSSProperties;
  /** Whether to show label text (useful for expanded sidebars) */
  showLabel?: boolean;
  /** Position of label when shown */
  labelPosition?: 'right' | 'bottom';
  /** Tab index for keyboard navigation */
  tabIndex?: number;
  /** Custom aria attributes */
  'aria-pressed'?: boolean;
  'aria-expanded'?: boolean;
  'aria-haspopup'?: boolean | 'menu' | 'listbox' | 'tree' | 'grid' | 'dialog';
}

// ============================================================================
// Size Configurations
// ============================================================================

const sizeConfig: Record<SidebarIconSize, { button: number; icon: number; font: number }> = {
  xs: { button: 28, icon: 14, font: 10 },
  sm: { button: 32, icon: 16, font: 11 },
  md: { button: 40, icon: 20, font: 12 },
  lg: { button: 48, icon: 24, font: 13 },
  xl: { button: 56, icon: 28, font: 14 },
};

// ============================================================================
// Styles
// ============================================================================

const baseStyles: Record<string, React.CSSProperties> = {
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    backgroundColor: 'transparent',
    color: 'var(--sidebar-icon-fg, var(--color-foreground, hsl(var(--foreground, 222.2 84% 4.9%))))',
    position: 'relative',
    flexShrink: 0,
    gap: '8px',
    // Longhand (not the `padding` shorthand) so buttonWithLabel can override
    // paddingLeft/Right without React's shorthand/longhand collision warning.
    paddingTop: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    paddingRight: 0,
  },
  buttonWithLabel: {
    justifyContent: 'flex-start',
    paddingLeft: '12px',
    paddingRight: '12px',
  },
  iconWrapper: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  label: {
    fontWeight: 500,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  badge: {
    position: 'absolute',
    top: '-4px',
    right: '-4px',
    fontSize: '10px',
    fontWeight: 600,
    borderRadius: '9999px',
    padding: '2px 6px',
    minWidth: '16px',
    textAlign: 'center',
    lineHeight: 1.2,
  },
  badgeWithLabel: {
    position: 'static',
    marginLeft: 'auto',
  },
};

const badgeVariantStyles: Record<string, React.CSSProperties> = {
  default: {
    backgroundColor: 'var(--sidebar-badge-bg, var(--primary, #3b82f6))',
    color: 'var(--sidebar-badge-fg, white)',
  },
  destructive: {
    backgroundColor: 'var(--sidebar-badge-destructive, var(--destructive, #ef4444))',
    color: 'white',
  },
  warning: {
    backgroundColor: 'var(--sidebar-badge-warning, #f59e0b)',
    color: 'white',
  },
  success: {
    backgroundColor: 'var(--sidebar-badge-success, #10b981)',
    color: 'white',
  },
};

// ============================================================================
// Component
// ============================================================================

export const SidebarIcon: React.FC<SidebarIconProps> = ({
  icon,
  label,
  tooltip,
  active = false,
  disabled = false,
  badge,
  badgeVariant = 'default',
  size = 'md',
  variant = 'default',
  onClick,
  className,
  style,
  showLabel = false,
  labelPosition = 'right',
  tabIndex,
  ...ariaProps
}) => {
  const sizes = sizeConfig[size];
  
  const buttonStyle: React.CSSProperties = {
    ...baseStyles.button,
    width: showLabel && labelPosition === 'right' ? 'auto' : sizes.button,
    height: sizes.button,
    minWidth: sizes.button,
    ...(showLabel && labelPosition === 'right' ? baseStyles.buttonWithLabel : {}),
    ...(active ? {
      backgroundColor: 'hsl(var(--primary) / 0.10)',
      color: 'hsl(var(--primary))',
      border: `1px solid hsl(var(--primary) / 0.15)`,
    } : {}),
    ...(disabled ? {
      opacity: 0.5,
      cursor: 'not-allowed',
    } : {}),
    ...(variant === 'outline' ? {
      border: '1px solid var(--sidebar-icon-border, var(--border, #e5e7eb))',
    } : {}),
    ...(variant === 'filled' && !active ? {
      backgroundColor: 'var(--sidebar-icon-filled-bg, rgba(0, 0, 0, 0.05))',
    } : {}),
    ...style,
  };

  const iconWrapperStyle: React.CSSProperties = {
    ...baseStyles.iconWrapper,
    width: sizes.icon,
    height: sizes.icon,
  };

  const labelStyle: React.CSSProperties = {
    ...baseStyles.label,
    fontSize: sizes.font,
  };

  const badgeStyle: React.CSSProperties = {
    ...baseStyles.badge,
    ...(showLabel ? baseStyles.badgeWithLabel : {}),
    ...badgeVariantStyles[badgeVariant],
  };

  const handleMouseEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!active && !disabled) {
      e.currentTarget.style.backgroundColor = 'var(--sidebar-icon-hover-bg, hsl(var(--accent, 27 96% 61%) / 0.15))';
      e.currentTarget.style.color = 'var(--sidebar-icon-hover-fg, hsl(var(--accent, 27 96% 61%)))';
    }
  };

  const handleMouseLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!active && !disabled) {
      e.currentTarget.style.backgroundColor = variant === 'filled' 
        ? 'var(--sidebar-icon-filled-bg, rgba(0, 0, 0, 0.05))'
        : 'transparent';
      e.currentTarget.style.color = 'var(--sidebar-icon-fg, var(--color-foreground, hsl(var(--foreground, 222.2 84% 4.9%))))';
    }
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={tooltip || label}
      tabIndex={tabIndex}
      style={buttonStyle}
      className={className}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      {...ariaProps}
    >
      <span style={iconWrapperStyle}>{icon}</span>
      {showLabel && <span style={labelStyle}>{label}</span>}
      {badge !== undefined && (
        <span style={badgeStyle}>{badge}</span>
      )}
    </button>
  );
};

// ============================================================================
// SidebarIconGroup - Groups multiple icons together
// ============================================================================

export interface SidebarIconGroupProps {
  /** Icon elements */
  children: React.ReactNode;
  /** Direction of the group */
  direction?: 'vertical' | 'horizontal';
  /** Gap between icons */
  gap?: number;
  /** Alignment of icons */
  align?: 'start' | 'center' | 'end';
  /** Additional CSS classes */
  className?: string;
  /** Additional inline styles */
  style?: React.CSSProperties;
}

export const SidebarIconGroup: React.FC<SidebarIconGroupProps> = ({
  children,
  direction = 'vertical',
  gap = 8,
  align = 'center',
  className,
  style,
}) => {
  const groupStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: direction === 'vertical' ? 'column' : 'row',
    gap: `${gap}px`,
    alignItems: align === 'start' ? 'flex-start' : align === 'end' ? 'flex-end' : 'center',
    ...style,
  };

  return (
    <div className={className} style={groupStyle} role="group">
      {children}
    </div>
  );
};

// ============================================================================
// SidebarDivider - Visual separator between icon groups
// ============================================================================

export interface SidebarDividerProps {
  /** Direction matches parent group */
  direction?: 'vertical' | 'horizontal';
  /** Spacing around the divider */
  spacing?: number;
  /** Additional CSS classes */
  className?: string;
  /** Additional inline styles */
  style?: React.CSSProperties;
}

export const SidebarDivider: React.FC<SidebarDividerProps> = ({
  direction = 'vertical',
  spacing = 8,
  className,
  style,
}) => {
  const dividerStyle: React.CSSProperties = {
    backgroundColor: 'var(--sidebar-divider, var(--border, #e5e7eb))',
    flexShrink: 0,
    ...(direction === 'vertical' ? {
      height: '1px',
      width: '100%',
      margin: `${spacing}px 0`,
    } : {
      width: '1px',
      height: '100%',
      margin: `0 ${spacing}px`,
    }),
    ...style,
  };

  return <div className={className} style={dividerStyle} role="separator" />;
};

// ============================================================================
// SidebarSection - Labeled section of icons
// ============================================================================

export interface SidebarSectionProps {
  /** Section title */
  title?: string;
  /** Section content (icons) */
  children: React.ReactNode;
  /** Whether section is collapsible */
  collapsible?: boolean;
  /** Default collapsed state */
  defaultCollapsed?: boolean;
  /** Gap between icons */
  gap?: number;
  /** Additional CSS classes */
  className?: string;
  /** Additional inline styles */
  style?: React.CSSProperties;
}

export const SidebarSection: React.FC<SidebarSectionProps> = ({
  title,
  children,
  collapsible = false,
  defaultCollapsed = false,
  gap = 8,
  className,
  style,
}) => {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);

  const sectionStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    ...style,
  };

  const titleStyle: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    color: 'var(--sidebar-section-title, var(--foreground-muted, #6b7280))',
    padding: '8px 12px 4px',
    cursor: collapsible ? 'pointer' : 'default',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    userSelect: 'none',
  };

  const contentStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: `${gap}px`,
    padding: '4px 8px',
  };

  return (
    <div className={className} style={sectionStyle}>
      {title && (
        <div 
          style={titleStyle}
          onClick={() => collapsible && setCollapsed(!collapsed)}
          role={collapsible ? 'button' : undefined}
          aria-expanded={collapsible ? !collapsed : undefined}
        >
          <span>{title}</span>
          {collapsible && (
            <span style={{ 
              transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s ease',
            }}>
              ▼
            </span>
          )}
        </div>
      )}
      {(!collapsible || !collapsed) && (
        <div style={contentStyle}>
          {children}
        </div>
      )}
    </div>
  );
};

export default SidebarIcon;
