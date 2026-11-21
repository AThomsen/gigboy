import { useEffect, useState } from 'react';
import { dataClient } from '../lib/dataClient';

// Asked once per page load: the setting only changes when the server restarts.
let statusRequest: Promise<boolean> | null = null;

function loadSearchEnabled(): Promise<boolean> {
  statusRequest ??= dataClient.ultimateGuitar
    .getStatus()
    .then((status) => status.searchEnabled)
    .catch(() => {
      statusRequest = null; // Retry next time, e.g. after coming back online.
      return false;
    });
  return statusRequest;
}

/** Whether Ultimate Guitar search and link import are on. False until known. */
export function useUltimateGuitarSearch(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    void loadSearchEnabled().then((value) => {
      if (active) setEnabled(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return enabled;
}
