import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Record — FieldVision",
};

// mobile-web-app-capable + minimal-ui hides the address bar on Chrome/Safari
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RecordLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <meta name="mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      {children}
    </>
  );
}
