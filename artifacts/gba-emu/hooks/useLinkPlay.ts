import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { EmulatorRef } from '@/components/EmulatorWebView';

export type LinkPlayStatus =
  | 'idle'
  | 'connecting'
  | 'waiting'
  | 'connected'
  | 'error';

interface LinkPlayState {
  status: LinkPlayStatus;
  roomCode: string;
  role: 'host' | 'guest' | null;
  message: string;
}

interface UseLinkPlayOptions {
  romHash: string | null;
  emulatorRef: RefObject<EmulatorRef | null>;
}

interface ServerMessage {
  type?: string;
  code?: string;
  role?: 'host' | 'guest';
  playerId?: number;
  status?: 'waiting' | 'connected';
  message?: string;
  reason?: string;
  id?: number;
  data?: number;
  words?: number[];
}

const INITIAL_STATE: LinkPlayState = {
  status: 'idle',
  roomCode: '',
  role: null,
  message: '',
};

function websocketUrl(): string | null {
  const configuredDomain = process.env.EXPO_PUBLIC_DOMAIN?.trim();
  if (configuredDomain) return `wss://${configuredDomain}/api/link`;
  if (typeof window !== 'undefined' && window.location.host) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/api/link`;
  }
  return null;
}

export function useLinkPlay({ romHash, emulatorRef }: UseLinkPlayOptions) {
  const socketRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transferTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const connectedRef = useRef(false);
  const lastServerMessageAtRef = useRef(0);
  const [state, setState] = useState<LinkPlayState>(INITIAL_STATE);

  const clearTimers = useCallback(() => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
    if (transferTimeoutRef.current) clearTimeout(transferTimeoutRef.current);
    heartbeatRef.current = null;
    connectTimeoutRef.current = null;
    transferTimeoutRef.current = null;
  }, []);

  const setCoreDisconnected = useCallback(() => {
    connectedRef.current = false;
    emulatorRef.current?.setLinkSession(false, 0);
    emulatorRef.current?.abortLinkTransfer();
  }, [emulatorRef]);

  const disposeSocket = useCallback((sendLeave: boolean) => {
    const socket = socketRef.current;
    socketRef.current = null;
    generationRef.current += 1;
    connectedRef.current = false;
    clearTimers();
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        if (sendLeave) socket.send(JSON.stringify({ type: 'leave' }));
        socket.close(1000, 'Leaving Link Play');
      } catch {
        socket.close();
      }
    } else {
      socket?.close();
    }
  }, [clearTimers]);

  const failConnection = useCallback((message: string) => {
    disposeSocket(true);
    setCoreDisconnected();
    setState({
      status: 'error',
      roomCode: '',
      role: null,
      message,
    });
  }, [disposeSocket, setCoreDisconnected]);

  const clearTransferDeadline = useCallback(() => {
    if (transferTimeoutRef.current) clearTimeout(transferTimeoutRef.current);
    transferTimeoutRef.current = null;
  }, []);

  const armTransferDeadline = useCallback(() => {
    clearTransferDeadline();
    const generation = generationRef.current;
    transferTimeoutRef.current = setTimeout(() => {
      if (generationRef.current !== generation) return;
      failConnection('Cable transfer timed out. The room was closed so the game can continue safely.');
    }, 12_000);
  }, [clearTransferDeadline, failConnection]);

  const leaveRoom = useCallback(() => {
    disposeSocket(true);
    setCoreDisconnected();
    setState(INITIAL_STATE);
  }, [disposeSocket, setCoreDisconnected]);

  const handleServerMessage = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case 'room': {
        const status = message.status === 'connected' ? 'connected' : 'waiting';
        const playerId = message.playerId === 1 ? 1 : 0;
        connectedRef.current = status === 'connected';
        setState({
          status,
          roomCode: message.code ?? '',
          role: message.role ?? null,
          message:
            status === 'connected'
              ? `Player ${playerId + 1} · cable connected`
              : 'Waiting for player 2',
        });
        emulatorRef.current?.setLinkSession(status === 'connected', playerId);
        break;
      }
      case 'serial-start':
        if (Number.isInteger(message.id)) {
          emulatorRef.current?.receiveLinkStart(message.id!);
        }
        break;
      case 'serial-complete':
        if (
          Number.isInteger(message.id) &&
          Array.isArray(message.words) &&
          message.words.length >= 2
        ) {
          clearTransferDeadline();
          emulatorRef.current?.receiveLinkComplete(message.id!, message.words);
        }
        break;
      case 'serial-timeout':
        failConnection('Cable transfer timed out. The room was closed so the game can continue safely.');
        break;
      case 'peer-left':
        clearTransferDeadline();
        setCoreDisconnected();
        setState((current) => ({
          ...current,
          status: 'waiting',
          message: 'Player 2 disconnected · waiting for a new connection',
        }));
        break;
      case 'room-ended':
        failConnection(message.reason ?? 'The Link Play room ended.');
        break;
      case 'error':
        clearTransferDeadline();
        emulatorRef.current?.abortLinkTransfer();
        setState((current) => ({
          ...current,
          status:
            current.status === 'connected' || current.status === 'waiting'
              ? current.status
              : 'error',
          message: message.message ?? 'Link Play could not complete that request.',
        }));
        break;
      default:
        break;
    }
  }, [
    clearTransferDeadline,
    emulatorRef,
    failConnection,
    setCoreDisconnected,
  ]);

  const connect = useCallback((action: 'create' | 'join', code?: string) => {
    if (!romHash) {
      setState({
        status: 'error',
        roomCode: '',
        role: null,
        message: 'Wait for the game compatibility check to finish.',
      });
      return;
    }
    const url = websocketUrl();
    if (!url) {
      setState({
        status: 'error',
        roomCode: '',
        role: null,
        message: 'Link Play server address is unavailable in this build.',
      });
      return;
    }

    disposeSocket(false);
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    connectedRef.current = false;
    setCoreDisconnected();
    setState({
      status: 'connecting',
      roomCode: '',
      role: null,
      message: action === 'create' ? 'Creating private room…' : 'Joining private room…',
    });

    const socket = new WebSocket(url);
    socketRef.current = socket;
    connectTimeoutRef.current = setTimeout(() => {
      if (
        socketRef.current === socket &&
        generationRef.current === generation &&
        socket.readyState !== WebSocket.OPEN
      ) {
        failConnection('Link Play server did not respond. Try again.');
      }
    }, 10_000);

    socket.onopen = () => {
      if (socketRef.current !== socket || generationRef.current !== generation) return;
      if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
      socket.send(JSON.stringify({
        type: action,
        protocol: 1,
        romHash,
        ...(action === 'join' ? { code: code?.trim().toUpperCase() } : {}),
      }));
      lastServerMessageAtRef.current = Date.now();
      heartbeatRef.current = setInterval(() => {
        if (socketRef.current !== socket || generationRef.current !== generation) return;
        if (Date.now() - lastServerMessageAtRef.current > 35_000) {
          failConnection('Link Play stopped responding. The room was closed so the game can continue.');
          return;
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
      }, 15_000);
    };
    socket.onmessage = (event) => {
      if (socketRef.current !== socket || generationRef.current !== generation) return;
      lastServerMessageAtRef.current = Date.now();
      try {
        handleServerMessage(JSON.parse(String(event.data)) as ServerMessage);
      } catch {
        setState((current) => ({ ...current, message: 'Invalid response from Link Play server.' }));
      }
    };
    socket.onerror = () => {
      if (socketRef.current !== socket || generationRef.current !== generation) return;
      failConnection('Link Play connection failed. Check your internet connection.');
    };
    socket.onclose = () => {
      if (socketRef.current !== socket || generationRef.current !== generation) return;
      clearTimers();
      socketRef.current = null;
      generationRef.current += 1;
      setCoreDisconnected();
      setState((current) => ({
        ...current,
        status: 'error',
        message: 'Link Play connection closed. Create or join a room again.',
      }));
    };
  }, [
    clearTimers,
    disposeSocket,
    failConnection,
    handleServerMessage,
    romHash,
    setCoreDisconnected,
  ]);

  const createRoom = useCallback(() => connect('create'), [connect]);
  const joinRoom = useCallback((code: string) => connect('join', code), [connect]);

  const sendSerialStart = useCallback((id: number, data: number) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN && connectedRef.current) {
      armTransferDeadline();
      try {
        socket.send(JSON.stringify({ type: 'serial-start', id, data }));
      } catch {
        failConnection('Link Play could not send the cable word. The room was closed safely.');
      }
    } else {
      emulatorRef.current?.abortLinkTransfer();
    }
  }, [armTransferDeadline, emulatorRef, failConnection]);

  const sendSerialReply = useCallback((id: number, data: number) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN && connectedRef.current) {
      armTransferDeadline();
      try {
        socket.send(JSON.stringify({ type: 'serial-reply', id, data }));
      } catch {
        failConnection('Link Play could not send the cable reply. The room was closed safely.');
      }
    } else {
      emulatorRef.current?.abortLinkTransfer();
    }
  }, [armTransferDeadline, emulatorRef, failConnection]);

  useEffect(() => {
    return () => {
      disposeSocket(true);
      setCoreDisconnected();
    };
  }, [disposeSocket, setCoreDisconnected]);

  useEffect(() => {
    if (state.status !== 'idle' && !romHash) leaveRoom();
  }, [leaveRoom, romHash, state.status]);

  return {
    ...state,
    createRoom,
    joinRoom,
    leaveRoom,
    sendSerialStart,
    sendSerialReply,
  };
}