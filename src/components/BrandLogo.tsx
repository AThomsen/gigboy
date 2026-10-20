interface BrandLogoProps {
  size: number;
  className?: string;
}

/** The setlist-sheet app icon. Decorative: the GIGBOY wordmark next to it carries the name. */
export default function BrandLogo({ size, className }: BrandLogoProps) {
  return (
    <img
      className={['brand-logo', className].filter(Boolean).join(' ')}
      src={`${import.meta.env.BASE_URL}logo.svg`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  );
}
