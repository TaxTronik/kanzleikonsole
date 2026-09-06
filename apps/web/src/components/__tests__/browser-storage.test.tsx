import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBrowserStorage, useBrowserStorage, writeBrowserStorage } from '../use-browser-storage';
import { ConsentFields } from '../consent-fields';

afterEach(() => vi.unstubAllGlobals());

describe('browser preferences and client hydration', () => {
  it('publishes same-tab writes only after the new snapshot is readable', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const dispatchEvent = vi.fn((event: CustomEvent<string>) => {
      expect(event.detail).toBe('test:saved-views');
      expect(readBrowserStorage(event.detail)).toBe('latest view');
      return true;
    });
    vi.stubGlobal('window', { dispatchEvent });

    writeBrowserStorage('test:saved-views', 'latest view');
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });

  it('retains choices in this browser session when persistent storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('Storage blocked');
      },
      setItem: () => {
        throw new Error('Storage blocked');
      },
    });
    vi.stubGlobal('window', new EventTarget());
    expect(readBrowserStorage('test:private-session')).toBeNull();
    writeBrowserStorage('test:private-session', 'one');
    writeBrowserStorage('test:private-session', 'two');
    expect(readBrowserStorage('test:private-session')).toBe('two');
  });

  it('renders a stable server snapshot without reading browser-only preferences', () => {
    const getItem = vi.fn(() => 'browser-only data');
    vi.stubGlobal('localStorage', { getItem });
    function Preference() {
      return <span>{useBrowserStorage('test:hydrate') ?? 'loading'}</span>;
    }
    expect(renderToStaticMarkup(<Preference />)).toBe('<span>loading</span>');
    expect(getItem).not.toHaveBeenCalled();
  });

  it('renders consent selections without reading mutable refs during rendering', () => {
    const onChange = vi.fn();
    const markup = renderToStaticMarkup(<ConsentFields onChange={onChange} />);
    expect(markup).toContain('name="consentsJson"');
    expect(markup).toContain('type="checkbox"');
    expect(onChange).not.toHaveBeenCalled();
  });
});
