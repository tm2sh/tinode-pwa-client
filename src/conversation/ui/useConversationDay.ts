import { useEffect, useState } from 'react';

// A single wake-up at local midnight keeps open conversations current.
export function useConversationDay(): number {
  const [reference, setReference] = useState(Date.now);
  useEffect(() => {
    let timer: number;
    const update = () => {
      window.clearTimeout(timer);
      const now = new Date();
      setReference(previous => new Date(previous).toDateString() === now.toDateString() ? previous : now.getTime());
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = window.setTimeout(update, Math.max(1, midnight.getTime() - now.getTime()));
    };
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
    };
  }, []);
  return reference;
}
