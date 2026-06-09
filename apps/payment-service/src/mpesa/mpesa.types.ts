// ─── Daraja API Types ─────────────────────────────────────────────────────────

export interface DarajaTokenResponse {
  access_token: string;
  expires_in: string;
}

export interface StkPushRequest {
  BusinessShortCode: string;
  Password: string;
  Timestamp: string;
  TransactionType: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline';
  Amount: number;
  PartyA: string;  // Customer phone: 254XXXXXXXXX
  PartyB: string;  // Shortcode
  PhoneNumber: string;
  CallBackURL: string;
  AccountReference: string; // Max 12 chars
  TransactionDesc: string;  // Max 13 chars
}

export interface StkPushResponse {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
  ResponseDescription: string;
  CustomerMessage: string;
}

export interface StkCallbackMetadataItem {
  Name: string;
  Value?: string | number;
}

export interface StkCallbackBody {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResultCode: number;
  ResultDesc: string;
  CallbackMetadata?: {
    Item: StkCallbackMetadataItem[];
  };
}

export interface StkCallback {
  Body: {
    stkCallback: StkCallbackBody;
  };
}

export interface StkQueryResponse {
  ResponseCode: string;
  ResponseDescription: string;
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResultCode: string;
  ResultDesc: string;
}

export interface B2cRequest {
  InitiatorName: string;
  SecurityCredential: string;
  CommandID: 'BusinessPayment' | 'SalaryPayment' | 'PromotionPayment';
  Amount: number;
  PartyA: string;  // Shortcode
  PartyB: string;  // Customer phone: 254XXXXXXXXX
  Remarks: string;
  QueueTimeOutURL: string;
  ResultURL: string;
  Occasion?: string;
}

export interface B2cResponse {
  ConversationID: string;
  OriginatorConversationID: string;
  ResponseCode: string;
  ResponseDescription: string;
}

export interface B2cResultTransaction {
  ResultType: number;
  ResultCode: number;
  ResultDesc: string;
  OriginatorConversationID: string;
  ConversationID: string;
  TransactionID: string;
  ResultParameters?: {
    ResultParameter: Array<{ Key: string; Value: string | number }>;
  };
}

export interface B2cResult {
  Result: B2cResultTransaction;
}

export interface B2cTimeout {
  Result: {
    ResultType: number;
    ResultCode: number;
    ResultDesc: string;
    OriginatorConversationID: string;
    ConversationID: string;
    TransactionID: string;
  };
}

// ─── Safaricom Result Codes ───────────────────────────────────────────────────

export const MPESA_SUCCESS_CODE = 0;

export const MPESA_ERROR_CODES: Record<number, string> = {
  1: 'Insufficient funds',
  2: 'Less than minimum transaction value',
  3: 'More than maximum transaction value',
  4: 'Would exceed daily transfer limit',
  5: 'Would exceed minimum balance',
  6: 'Unresolved primary party',
  7: 'Unresolved receiver party',
  8: 'Would exceed maximum balance',
  11: 'Debit account invalid',
  12: 'Credit account invalid',
  13: 'Unresolved debit account',
  14: 'Unresolved credit account',
  15: 'Duplicate detected',
  17: 'Internal failure',
  20: 'Unresolved initiator',
  26: 'Traffic blocking condition in place',
  1032: 'Request cancelled by user',
  1037: 'DS timeout user cannot be reached',
};
