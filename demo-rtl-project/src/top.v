module top (
    input wire clk,
    input wire rst_n,
    output reg done
);

always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        done <= 1'b0;
    end else begin
        done <= 1'b1
    end
end

endmodule
