import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-control-hover text-foreground shadow-none hover:bg-foreground/15 dark:bg-[#5f5f5c] dark:text-[#f5f3ee] dark:hover:bg-[#6d6d69]",
        ghost: "border border-card-border bg-control text-foreground hover:border-foreground/30 hover:bg-control-hover",
        soft: "bg-brand-soft text-foreground hover:bg-brand-soft/80",
        danger: "bg-red-600 text-white hover:bg-red-700",
      },
      size: {
        sm: "h-7 px-2.5 text-xs",
        md: "h-9 px-3",
        lg: "h-10 px-4",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);

Button.displayName = "Button";
