export type Role = 'host' | 'guest' | '';
export type P2PStatus = 'disconnected' | 'connecting' | 'connected' | 'failed';

export interface FileMeta {
  name: string;
  size: number;
  type: string;
}

export interface SignalMessage {
  type: 'role' | 'join_request' | 'join_approve' | 'join_reject' | 'offer' | 'answer' | 'candidate';
  [key: string]: any;
}