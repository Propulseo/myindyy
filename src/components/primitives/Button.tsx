import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "quiet" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-sm border font-sans " +
  "whitespace-nowrap transition-colors duration-150 " +
  "disabled:cursor-not-allowed disabled:opacity-45";

const VARIANTS: Record<ButtonVariant, string> = {
  // Un seul bouton plein par écran : l'action que l'on attend vraiment.
  primary:
    "border-indy bg-indy text-obsidian font-medium hover:bg-indy/85 hover:border-indy/85",
  quiet:
    "border-line-strong bg-surface text-ivory hover:bg-raised hover:border-muted/50",
  ghost:
    "border-transparent bg-transparent text-muted hover:text-ivory hover:bg-raised",
  danger:
    "border-danger/40 bg-danger/10 text-danger hover:bg-danger/18 hover:border-danger/60",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[0.8125rem]",
  md: "h-10 px-4 text-sm",
};

export function buttonClasses(
  variant: ButtonVariant = "quiet",
  size: ButtonSize = "md",
  extra?: string,
): string {
  return cn(BASE, VARIANTS[variant], SIZES[size], extra);
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

export function Button({
  variant = "quiet",
  size = "md",
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button type={type} className={buttonClasses(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}
