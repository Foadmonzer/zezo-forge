'use client';

import { useEffect, useRef } from 'react';

export default function LegacyApplication({ markup }: { markup: string }) {
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    const script = document.createElement('script');
    script.type = 'module';
    script.src = '/app.js';
    script.dataset.zezoLegacyApp = 'true';
    script.addEventListener('load', () => {
      document.documentElement.dataset.zezoAppReady = 'true';
    }, { once: true });
    document.body.append(script);
    return () => script.remove();
  }, []);

  return <div id="zezo-legacy-root" dangerouslySetInnerHTML={{ __html: markup }} />;
}
