import { Header } from '@/components/landing/Header';
import { Hero } from '@/components/landing/Hero';
import { Problem } from '@/components/landing/Problem';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { Safety } from '@/components/landing/Safety';
import { WhoItsFor } from '@/components/landing/WhoItsFor';
import { Pilot } from '@/components/landing/Pilot';
import { Contact } from '@/components/landing/Contact';
import { Footer } from '@/components/landing/Footer';

export default function Landing() {
  return (
    <>
      <Header />
      <Hero />
      <Problem />
      <HowItWorks />
      <Safety />
      <WhoItsFor />
      <Pilot />
      <Contact />
      <Footer />
    </>
  );
}
