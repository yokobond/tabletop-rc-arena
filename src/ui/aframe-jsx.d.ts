import type { DetailedHTMLProps, HTMLAttributes } from 'react';

// A-Frame components are plain string attributes, whichever names are registered.
type AFrameProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { [component: string]: unknown };

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'a-scene': AFrameProps;
      'a-entity': AFrameProps;
    }
  }
}
