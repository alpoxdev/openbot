import { useState } from "react";
import { isOpenBotSiteUrl } from "./openbot-site-url";

export type ConnectionChoice = "local" | "remote";

/**
 * Where OpenBot should run, asked after Welcome and before anything technical.
 *
 * Welcome stays one button for people who have not decided to care yet. This screen is the first
 * place a URL appears, and only for the people who chose a server they already have.
 */
export function Connect({
  choice,
  remoteUrl,
  remoteError,
  onChooseLocal,
  onChooseRemote,
  onChangeRemoteUrl,
  onContinueRemote,
  onBack,
  onForget,
}: {
  choice: ConnectionChoice | null;
  remoteUrl: string;
  remoteError: string | null;
  onChooseLocal: () => void;
  onChooseRemote: () => void;
  onChangeRemoteUrl: (value: string) => void;
  onContinueRemote: () => void;
  onBack: () => void;
  onForget: () => void;
}) {
  const [pickingRemote, setPickingRemote] = useState(false);
  const remoteReady = isOpenBotSiteUrl(remoteUrl);

  if (pickingRemote) {
    return (
      <div className="sheet">
        <p className="steps-of">Step 2 of setup</p>
        <h1>Open the OpenBot your team already set up</h1>
        <p className="lede">
          Paste the OpenBot address you use in a browser. This window will open
          it here. Nothing is installed on this computer.
        </p>
        <div className="field">
          <label htmlFor="openbot-site">OpenBot address</label>
          <input
            id="openbot-site"
            value={remoteUrl}
            onChange={(event) => onChangeRemoteUrl(event.target.value)}
            placeholder="https://openbot.example.com"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        {remoteError && (
          <p className="footnote" role="alert">
            {remoteError}
          </p>
        )}
        <div className="row">
          <button
            type="button"
            className="quiet"
            onClick={() => setPickingRemote(false)}
          >
            Back
          </button>
          <button
            type="button"
            disabled={!remoteReady}
            onClick={onContinueRemote}
          >
            Open OpenBot
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="sheet">
      <p className="steps-of">Step 2 of setup</p>
      <h1>Where should OpenBot run?</h1>
      <p className="lede">
        Most people run it on this computer. If your team already has OpenBot on
        a server, open that instead.
      </p>
      <fieldset className="picker">
        <legend className="sr-only">Where OpenBot should run</legend>
        <button
          type="button"
          className={
            choice === "local" ? "tile connect-tile chosen" : "tile connect-tile"
          }
          onClick={onChooseLocal}
        >
          <span className="tile-name">On this computer</span>
          <span className="tile-summary">
            Install and run it here. Takes a few minutes.
          </span>
        </button>
        <button
          type="button"
          className="tile connect-tile"
          onClick={() => {
            setPickingRemote(true);
            onChooseRemote();
          }}
        >
          <span className="tile-name">On a server we already have</span>
          <span className="tile-summary">
            Open the OpenBot site your team already set up.
          </span>
        </button>
      </fieldset>
      {choice === "remote" && remoteUrl.trim() !== "" && (
        <p className="footnote">
          This window will open that saved OpenBot again next time, unless you
          choose a different one.
        </p>
      )}
      <div className="row">
        <button type="button" className="quiet" onClick={onBack}>
          Back
        </button>
        {choice !== null && (
          <button type="button" className="quiet" onClick={onForget}>
            Use a different OpenBot
          </button>
        )}
      </div>
    </div>
  );
}
