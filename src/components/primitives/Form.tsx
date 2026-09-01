"use client";

import * as RadioGroup from "@radix-ui/react-radio-group";
import { ChevronDown, Search } from "lucide-react";
import { useId } from "react";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "./cn";

const CONTROL =
  "w-full rounded-sm border border-line-strong bg-obsidian px-3 text-sm text-ivory " +
  "placeholder:text-muted/70 transition-colors hover:border-muted/50 " +
  "focus:border-indy focus:bg-raised";

export function Field({
  label,
  hint,
  optional,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: (props: { id: string; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="flex items-baseline gap-2">
        <span className="text-[0.8125rem] font-medium text-ivory">{label}</span>
        {optional ? (
          <span className="label-mono text-[0.625rem]">facultatif</span>
        ) : null}
      </label>
      {children({ id, "aria-describedby": hintId })}
      {hint ? (
        <p id={hintId} className="text-xs leading-relaxed text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextInput({
  className,
  ...rest
}: ComponentPropsWithRef<"input">) {
  return <input className={cn(CONTROL, "h-10", className)} {...rest} />;
}

export function TextArea({
  className,
  ...rest
}: ComponentPropsWithRef<"textarea">) {
  return (
    <textarea
      className={cn(CONTROL, "min-h-24 resize-y py-2.5 leading-relaxed", className)}
      {...rest}
    />
  );
}

export function SelectInput({
  className,
  children,
  ...rest
}: ComponentPropsWithRef<"select">) {
  return (
    <div className="relative">
      <select className={cn(CONTROL, "h-10 appearance-none pr-9", className)} {...rest}>
        {children}
      </select>
      <ChevronDown
        aria-hidden
        size={14}
        strokeWidth={1.75}
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted"
      />
    </div>
  );
}

export function SearchInput({
  className,
  ...rest
}: ComponentPropsWithRef<"input">) {
  return (
    <div className="relative">
      <Search
        aria-hidden
        size={14}
        strokeWidth={1.75}
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
      />
      <input
        type="search"
        className={cn(CONTROL, "h-9 pl-9", className)}
        {...rest}
      />
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

const SEGMENT_GRID: Record<3 | 4, string> = {
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
};

/** Choix unique présenté comme un segment. Radix gère les flèches du clavier. */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  columns = 3,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: SegmentedOption<T>[];
  ariaLabel: string;
  columns?: 3 | 4;
}) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      aria-label={ariaLabel}
      className={cn("grid gap-1.5", SEGMENT_GRID[columns])}
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          className={cn(
            "rounded-sm border px-3 py-2 text-left transition-colors",
            "border-line-strong bg-obsidian hover:border-muted/50",
            "data-[state=checked]:border-indy data-[state=checked]:bg-indy/10",
          )}
        >
          <span className="block text-[0.8125rem] font-medium text-ivory">
            {option.label}
          </span>
          {option.hint ? (
            <span className="mt-0.5 block text-xs leading-snug text-muted">
              {option.hint}
            </span>
          ) : null}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
