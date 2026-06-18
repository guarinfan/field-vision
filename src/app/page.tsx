import Link from "next/link";
import { Camera, Layers, Zap, Trophy } from "lucide-react";

export default function Home() {
  return (
    <main className="flex flex-col min-h-screen">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-green-900/40">
        <span className="text-xl font-bold tracking-tight text-green-400">FieldVision</span>
        <div className="flex items-center gap-3">
          <Link href="/sessions" className="text-sm text-green-400 hover:text-green-300 font-medium transition-colors">
            My Sessions
          </Link>
          <Link
            href="/session/new"
            className="bg-green-500 hover:bg-green-400 text-black font-semibold text-sm px-4 py-2 rounded-lg transition-colors"
          >
            Start Recording
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex flex-col items-center justify-center flex-1 text-center px-6 py-24 gap-6">
        <div className="inline-flex items-center gap-2 bg-green-900/30 border border-green-700/50 text-green-400 text-xs font-medium px-3 py-1 rounded-full mb-2">
          <Zap size={12} /> AI-powered · Two phones · Full pitch coverage
        </div>
        <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-none max-w-4xl">
          Your pitch.<br />
          <span className="text-green-400">Every angle.</span>
        </h1>
        <p className="text-lg text-green-200/60 max-w-xl">
          Mount two phones on the sideline, press record, and FieldVision stitches them into a seamless panoramic view — then tracks the ball and cuts your highlights automatically.
        </p>
        <div className="flex gap-3 mt-4">
          <Link
            href="/session/new"
            className="bg-green-500 hover:bg-green-400 text-black font-bold px-6 py-3 rounded-xl transition-colors text-sm"
          >
            Create a Match Session
          </Link>
          <a
            href="#how-it-works"
            className="border border-green-700/50 hover:border-green-500 text-green-300 font-semibold px-6 py-3 rounded-xl transition-colors text-sm"
          >
            How it works
          </a>
        </div>
      </section>

      {/* Field diagram */}
      <section className="px-6 pb-16 flex justify-center">
        <div className="relative w-full max-w-2xl aspect-[2/1] bg-green-950/40 border border-green-800/40 rounded-2xl overflow-hidden flex items-center justify-center">
          <div className="absolute inset-4 border border-green-700/30 rounded" />
          <div className="absolute left-1/2 top-4 bottom-4 w-px bg-green-700/30" />
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 border border-green-700/30 rounded-full" />
          <div className="absolute left-4 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1">
            <div className="bg-green-500/20 border border-green-500/50 rounded-lg p-2">
              <Camera size={16} className="text-green-400" />
            </div>
            <span className="text-[10px] text-green-500/70 font-mono">CAM L</span>
          </div>
          <div className="absolute right-4 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1">
            <div className="bg-blue-500/20 border border-blue-500/50 rounded-lg p-2">
              <Camera size={16} className="text-blue-400" />
            </div>
            <span className="text-[10px] text-blue-500/70 font-mono">CAM R</span>
          </div>
          <div className="absolute left-8 top-1/2 -translate-y-1/2 w-48 h-32 border-r-0 border border-green-500/20 rounded-l-full" />
          <div className="absolute right-8 top-1/2 -translate-y-1/2 w-48 h-32 border-l-0 border border-blue-500/20 rounded-r-full" />
          <div className="absolute inset-0 flex items-end justify-center pb-3">
            <span className="text-[11px] text-green-600/60 font-mono">FULL PITCH COVERAGE</span>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="px-6 py-16 border-t border-green-900/40">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl font-bold text-center mb-12">How it works</h2>
          <div className="grid md:grid-cols-4 gap-6">
            {[
              { icon: Camera, step: "01", title: "Set up two phones", desc: "Angle each phone to cover one half of the pitch from the sideline." },
              { icon: Layers, step: "02", title: "Upload both videos", desc: "Create a session and upload left + right camera footage." },
              { icon: Zap, step: "03", title: "AI stitches & tracks", desc: "Our pipeline syncs, stitches, and runs ball + player tracking on the full panorama." },
              { icon: Trophy, step: "04", title: "Get your highlights", desc: "Download the full film or jump straight to auto-generated highlight clips." },
            ].map(({ icon: Icon, step, title, desc }) => (
              <div key={step} className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-green-600">{step}</span>
                  <div className="bg-green-900/40 p-2 rounded-lg">
                    <Icon size={16} className="text-green-400" />
                  </div>
                </div>
                <h3 className="font-semibold text-green-100">{title}</h3>
                <p className="text-sm text-green-200/50">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t border-green-900/40 px-6 py-6 text-center text-xs text-green-700">
        FieldVision &copy; {new Date().getFullYear()}
      </footer>
    </main>
  );
}
