import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Bricks - Build anything with The Fixer",
  description:
    "Chat with The Fixer AI to design, build, and ship web apps in minutes.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider
      appearance={{
        baseTheme: dark,
        variables: {
          colorPrimary: "#22c55e",
        },
      }}
    >
      <html lang="en" className={`dark ${inter.variable} h-full antialiased`}>
        <body className="min-h-full flex flex-col font-sans bg-background text-foreground">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
