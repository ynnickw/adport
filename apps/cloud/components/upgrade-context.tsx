'use client';

import { createContext, useContext } from 'react';
import type { PlanId } from '@/lib/cloud/plans';
import type { BillingOptions } from '@/lib/cloud/billing-options';

interface UpgradeContextValue { planId: PlanId; canManageBilling: boolean; projectId?: string; billingOptions?: BillingOptions; }
const UpgradeContext = createContext<UpgradeContextValue>({ planId: 'reader', canManageBilling: false });

export function UpgradeProvider({ value, children }: { value: UpgradeContextValue; children: React.ReactNode }) {
  return <UpgradeContext.Provider value={value}>{children}</UpgradeContext.Provider>;
}

export function useUpgradeContext() { return useContext(UpgradeContext); }
