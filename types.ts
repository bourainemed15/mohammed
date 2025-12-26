
export enum SessionStatus {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  ACTIVE = 'ACTIVE',
  ERROR = 'ERROR'
}

export interface Message {
  role: 'user' | 'assistant';
  text: string;
  timestamp: Date;
}
