import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Outreach',
  description: 'Targeted US freelance client acquisition and CRM',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
