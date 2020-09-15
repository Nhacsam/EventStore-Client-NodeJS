import { AppendReq } from "../../../generated/streams_pb";
import { StreamIdentifier, Empty, UUID } from "../../../generated/shared_pb";
import { StreamsClient } from "../../../generated/streams_grpc_pb";

import {
  WriteResult,
  WriteResultFailure,
  WriteResultSuccess,
  CurrentRevision,
  ESDBConnection,
  ExpectedRevision,
} from "../../types";
import { Command } from "../Command";
import { EventData } from "../../events";

export class WriteEventsToStream extends Command {
  private readonly _stream: string;
  private _revision: ExpectedRevision;
  private _events: EventData[] = [];

  constructor(stream: string) {
    super();
    this._stream = stream;
    this._revision = "any";
  }

  /**
   * Asks the server to check the stream is at specific revision before writing events.
   * @param revision
   */
  expectedRevision(revision: ExpectedRevision): WriteEventsToStream {
    this._revision = revision;
    return this;
  }

  /**
   * Adds events to be sent to the server, can be called multiple times.
   * @param events Events sent to the server.
   */
  send(...events: EventData[]): WriteEventsToStream {
    this._events = this._events.concat(events);
    return this;
  }

  /**
   * Sends events to the server
   * @param connection
   */
  async execute(connection: ESDBConnection): Promise<WriteResult> {
    if (!this._events.length) {
      throw new Error("No events to send");
    }

    const header = new AppendReq();
    const options = new AppendReq.Options();
    const identifier = new StreamIdentifier();

    identifier.setStreamname(Buffer.from(this._stream).toString("base64"));
    options.setStreamIdentifier(identifier);

    switch (this._revision) {
      case "any": {
        options.setAny(new Empty());
        break;
      }
      case "no_stream": {
        options.setNoStream(new Empty());
        break;
      }
      case "stream_exists": {
        options.setStreamExists(new Empty());
        break;
      }
      default: {
        options.setRevision(this._revision);
        break;
      }
    }

    header.setOptions(options);

    const client = await connection._client(StreamsClient);

    return new Promise<WriteResult>((resolve) => {
      const sink = client.append(this.metadata, (error, resp) => {
        if (error != null) {
          const result: WriteResultFailure = {
            __typename: "failure",
            error,
          };

          return resolve(result);
        }

        if (resp.hasSuccess()) {
          const success = resp.getSuccess()!;
          const nextExpectedVersion = success.getCurrentRevision();
          const grpcPosition = success.getPosition();

          const position = grpcPosition
            ? {
                commit: grpcPosition.getCommitPosition(),
                prepare: grpcPosition.getPreparePosition(),
              }
            : undefined;

          const result: WriteResultSuccess = {
            __typename: "success",
            nextExpectedVersion,
            position,
          };

          return resolve(result);
        }

        if (resp.hasWrongExpectedVersion()) {
          const grpcError = resp.getWrongExpectedVersion()!;
          let current: CurrentRevision = "no_stream";
          let expected: ExpectedRevision = "any";

          if (grpcError.hasCurrentRevision()) {
            current = grpcError.getCurrentRevision();
          }

          if (grpcError.hasExpectedRevision()) {
            expected = grpcError.getExpectedRevision();
          } else if (grpcError.hasStreamExists()) {
            expected = "stream_exists";
          }

          const failure: WriteResultFailure = {
            __typename: "failure",
            error: {
              current: current,
              expected: expected,
            },
          };

          return resolve(failure);
        }
      });

      sink.write(header);

      for (const event of this._events) {
        const entry = new AppendReq();
        const message = new AppendReq.ProposedMessage();
        const id = new UUID();

        id.setString(event.id);

        message.setId(id);

        switch (event.payload.__typename) {
          case "json": {
            message.getMetadataMap().set("content-type", "application/json");
            const data = JSON.stringify(event.payload.payload);
            message.setData(Buffer.from(data, "binary").toString("base64"));
            break;
          }
          case "binary": {
            message
              .getMetadataMap()
              .set("content-type", "application/octet-stream");
            message.setData(event.payload.payload);
            break;
          }
        }
        message.getMetadataMap().set("type", event.eventType);
        entry.setProposedMessage(message);
        sink.write(entry);
      }

      sink.end();
    });
  }
}
