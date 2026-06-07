import React, { useCallback, useEffect, useRef, useState } from "react";
import "./SplashScreen.css";

const SPLASH_VIDEO = `${process.env.PUBLIC_URL || ""}/launch-animation.mp4`;
const ENTER_MS = 900;
const FADE_MS = 500;

export default function SplashScreen({ children }) {
  const videoRef = useRef(null);
  const finishedRef = useRef(false);
  const [phase, setPhase] = useState("splash");
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const finishSplash = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setPhase("entering");
    window.setTimeout(() => setPhase("ready"), ENTER_MS);
  }, []);

  useEffect(() => {
    if (prefersReducedMotion) {
      setPhase("ready");
      return undefined;
    }

    const video = videoRef.current;
    if (!video) return undefined;

    const onEnded = () => finishSplash();
    const onError = () => {
      console.warn("Splash video failed to load; skipping intro.");
      finishSplash();
    };

    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);

    const playPromise = video.play();
    if (playPromise?.catch) {
      playPromise.catch(() => finishSplash());
    }

    return () => {
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
    };
  }, [finishSplash, prefersReducedMotion]);

  const showOverlay = phase === "splash" || phase === "entering";

  return (
    <div className="splash-root">
      {showOverlay && (
        <div
          className={`splash-overlay${phase === "entering" ? " splash-overlay--fade" : ""}`}
          style={{ "--splash-fade-ms": `${FADE_MS}ms` }}
          aria-hidden={phase !== "splash"}
        >
          <video
            ref={videoRef}
            className="splash-video"
            src={SPLASH_VIDEO}
            muted
            playsInline
            preload="auto"
          />
        </div>
      )}

      <div
        className={`app-shell${
          phase === "ready"
            ? " app-shell--ready"
            : phase === "entering"
              ? " app-shell--entering"
              : " app-shell--waiting"
        }`}
        style={{ "--splash-enter-ms": `${ENTER_MS}ms` }}
      >
        {children}
      </div>
    </div>
  );
}
