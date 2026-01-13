import { render, screen } from '@testing-library/react';
import HomePage from '../app/page';
import '@testing-library/jest-dom';

describe('HomePage', () => {
  it('renders FluxDrop title', () => {
    render(<HomePage />);
    expect(screen.getByText('FluxDrop')).toBeInTheDocument();
  });
});
